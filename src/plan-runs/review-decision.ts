import type { ReviewDecision, ReviewStepRecord } from "./review.ts";
import {
	DEFAULT_REVIEW_BUDGET,
	type ReviewLoopBudget,
	reviewBudgetReason,
	reviewProgressDecision,
	stoppedReview,
} from "./review-progress.ts";
import { recoverReview } from "./review-recovery.ts";
import { parseVerdict, passedReviewCommit } from "./review-result.ts";

function acceptReview(last: ReviewStepRecord, report: string): ReviewDecision {
	if (last.gateVerified === false)
		return {
			kind: "finished",
			outcome: "broken",
			report: "The runtime did not independently verify the quality gate on this commit.",
		};
	const commit = passedReviewCommit(report);
	if (commit === null || (last.reviewedCommit !== undefined && commit !== last.reviewedCommit)) {
		return {
			kind: "finished",
			outcome: "broken",
			report: "The review did not confirm the pinned commit and complete quality gate.",
		};
	}
	return { kind: "finished", outcome: "passed", report };
}

export function decideReviewStep(
	steps: readonly ReviewStepRecord[],
	budget: ReviewLoopBudget = DEFAULT_REVIEW_BUDGET,
): ReviewDecision {
	return recoverReview(steps, budget, decideNextStep(steps, budget));
}

function decideNextStep(
	steps: readonly ReviewStepRecord[],
	budget: ReviewLoopBudget,
): ReviewDecision {
	const last = steps.at(-1);
	if (last === undefined) return { kind: "spawn", step: "review" };
	if (last.state === "running") return { kind: "wait" };
	if (last.state === "failed") {
		return { kind: "finished", outcome: "broken", report: `The ${last.step} run failed.` };
	}
	if (last.step === "rework") {
		const blocked = reviewBudgetReason(steps, budget);
		return blocked
			? stoppedReview(blocked, last.resultText ?? "")
			: { kind: "spawn", step: "review" };
	}

	return decideFinishedReview(steps, budget, last);
}

function decideFinishedReview(
	steps: readonly ReviewStepRecord[],
	budget: ReviewLoopBudget,
	last: ReviewStepRecord,
): ReviewDecision {
	const report = last.resultText ?? "";
	const verdict = parseVerdict(report);
	if (verdict === null) {
		return { kind: "finished", outcome: "broken", report: "The review gave no verdict." };
	}
	const progress = reviewProgressDecision(steps);
	if (progress?.kind === "finished") return progress;
	if (verdict === "PASS" && !progress) {
		return acceptReview(last, report);
	}
	if (last.evidenceRequired && !progress)
		return stoppedReview("missing_failing_reproduction", report, true);
	const blocked = reviewBudgetReason(steps, budget);
	if (blocked) return stoppedReview(blocked, report);
	if (steps.filter((s) => s.step === "rework").length >= budget.maxReworks)
		return stoppedReview("round_budget_exhausted", report);
	return progress ?? { kind: "spawn", step: "rework", findings: report };
}
