import type { ReviewEvidence } from "../core/review-findings.ts";
import type { ReviewDecision, ReviewStepRecord } from "./review.ts";

export const MAX_REWORKS = 8;
export interface ReviewLoopBudget {
	readonly maxReworks: number;
	readonly maxSteps: number;
	readonly maxCostUsd: number;
	readonly maxActiveMs: number;
}
export const DEFAULT_REVIEW_BUDGET: ReviewLoopBudget = {
	maxReworks: MAX_REWORKS,
	maxSteps: 24,
	maxCostUsd: 10,
	maxActiveMs: 7_200_000,
};

export function loadReviewBudget(
	env: Record<string, string | undefined> = process.env,
): ReviewLoopBudget {
	const value = (key: string, fallback: number) => {
		const raw = env[key];
		const number = raw === undefined ? fallback : Number(raw);
		if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ${key}`);
		return number;
	};
	return {
		maxReworks: Math.max(1, Math.floor(value("WARREN_REWORK_MAX_ROUNDS", MAX_REWORKS))),
		maxSteps: Math.max(1, Math.floor(value("WARREN_REWORK_MAX_STEPS", 24))),
		maxCostUsd: value("WARREN_REWORK_MAX_COST_USD", 10),
		maxActiveMs: value("WARREN_REWORK_MAX_ACTIVE_MS", 7_200_000),
	};
}

export function reviewBudgetReason(
	steps: readonly ReviewStepRecord[],
	budget: ReviewLoopBudget,
): string | null {
	if (steps.some((step) => step.costUsd === null || step.activeMs === null))
		return "budget_unknown";
	if (steps.length >= budget.maxSteps) return "step_budget_exhausted";
	if (steps.reduce((sum, step) => sum + (step.costUsd ?? 0), 0) >= budget.maxCostUsd)
		return "cost_budget_exhausted";
	if (steps.reduce((sum, step) => sum + (step.activeMs ?? 0), 0) >= budget.maxActiveMs)
		return "time_budget_exhausted";
	return null;
}

export function stoppedReview(reason: string, report: string, broken = false): ReviewDecision {
	return {
		kind: "finished",
		outcome: broken ? "broken" : "changes_left",
		report: `Review loop stopped: ${reason}.\n\n${report}`,
	};
}

function retainsOriginals(previous: ReviewEvidence, current: ReviewEvidence): boolean {
	return previous.findings.every(
		(finding) =>
			JSON.stringify(current.findings.find((next) => next.id === finding.id)) ===
			JSON.stringify(finding),
	);
}

/** Resolve findings from immutable test results, never from the reworker's claims. */
export function reviewProgressDecision(steps: readonly ReviewStepRecord[]): ReviewDecision | null {
	const last = steps.at(-1);
	if (!last?.evidenceRequired) return null;
	const evidence = last.evidence;
	const report = last.resultText ?? "";
	if (
		!evidence ||
		evidence.commit !== last.reviewedCommit ||
		evidence.results.some(
			(result) => result.error || (result.exitCode !== 0 && result.exitCode !== 1),
		)
	)
		return stoppedReview("reproduction_unverified", report, true);
	const previous = [...steps.slice(0, -1)].reverse().find((step) => step.evidence)?.evidence;
	if (previous && !retainsOriginals(previous, evidence))
		return stoppedReview("reproduction_changed_or_missing", report, true);
	const open = evidence.results
		.filter((result) => result.exitCode === 1)
		.map((result) => result.id);
	if (!open.length) return null;
	const priorOpen =
		previous?.results.filter((result) => result.exitCode === 1).map((result) => result.id) ?? [];
	const closed = priorOpen.filter((id) =>
		evidence.results.some((result) => result.id === id && result.exitCode === 0),
	);
	const regressed = previous?.results.some(
		(result) => result.exitCode === 0 && open.includes(result.id),
	);
	if (regressed) return stoppedReview("regression", report);
	if (priorOpen.length && !closed.length) return stoppedReview("no_progress", report);
	return {
		kind: "spawn",
		step: "rework",
		findings: `${report}\n\nOpen reproductions: ${open.join(", ")}. Verified closed: ${closed.join(", ") || "none (initial review)"}.`,
	};
}
