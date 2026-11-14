import { isRetryableChildFailure } from "./retry.ts";
import type { ReviewDecision, ReviewStepRecord } from "./review.ts";
import { type ReviewLoopBudget, reviewBudgetReason, stoppedReview } from "./review-progress.ts";

/** Recorded on review_step, so neither a restart nor a manual retry resets this allowance. */
const MAX_TECHNICAL_RECOVERIES = 2;
const STALLED = "no_progress";

function technicalFailure(last: ReviewStepRecord, report: string): boolean {
	if (last.state === "failed")
		return (
			isRetryableChildFailure(last.failureReason ?? null) ||
			(last.step !== "rework" && last.failureReason === "crashed")
		);
	if (last.step === "rework" || !last.evidenceRequired) return false;
	return (
		report === "The review gave no verdict." ||
		report.startsWith("Review loop stopped: reproduction_unverified.") ||
		report.startsWith("Review loop stopped: missing_failing_reproduction.") ||
		report === "The runtime did not independently verify the quality gate on this commit." ||
		report === "The review did not confirm the pinned commit and complete quality gate."
	);
}

/** Retry execution/protocol mistakes, never waive a gate or close a failing proof. */
export function recoverReview(
	steps: readonly ReviewStepRecord[],
	budget: ReviewLoopBudget,
	decision: ReviewDecision,
): ReviewDecision {
	const last = steps.at(-1);
	if (!last || decision.kind !== "finished" || decision.outcome === "passed") return decision;
	const stalled = decision.report.startsWith(`Review loop stopped: ${STALLED}.`);
	const technical = technicalFailure(last, decision.report);
	if (!stalled && !technical) return decision;
	const blocked = reviewBudgetReason(steps, budget);
	if (blocked) return stoppedReview(blocked, decision.report);
	if (stalled) {
		if (budget.stopOnNoProgress) return decision;
		if (
			steps.some((step) => step.recoveryReason === STALLED) ||
			steps.filter((step) => step.step === "rework").length >= (budget.maxReworks ?? Infinity)
		)
			return decision;
		return { kind: "spawn", step: "rework", findings: decision.report, recoveryReason: STALLED };
	}
	if (
		steps.filter((step) => step.recoveryReason && step.recoveryReason !== STALLED).length >=
		MAX_TECHNICAL_RECOVERIES
	)
		return decision;
	return recoverTechnicalStep(steps, last, decision.report);
}
function recoverTechnicalStep(
	steps: readonly ReviewStepRecord[],
	last: ReviewStepRecord,
	report: string,
): ReviewDecision {
	if (last.step === "rework")
		return {
			kind: "spawn",
			step: "rework",
			findings:
				[...steps].reverse().find((step) => step.step === "review" && step.resultText)
					?.resultText ?? report,
			recoveryReason: last.failureReason ?? report,
		};
	return { kind: "spawn", step: "review", recoveryReason: last.failureReason ?? report };
}
