import type { ReviewStepSummary } from "../../api/review-types.ts";

export type HistoryFilter = "all" | "review" | "ui_review" | "rework";

/** Number in execution order before filtering/reversing, so links keep their familiar labels. */
export function historyEntries(steps: readonly ReviewStepSummary[]) {
	const counts = { review: 0, ui_review: 0, rework: 0 };
	const names = { review: "Review", ui_review: "UI/UX review", rework: "Rework" };
	return steps.map((step) => ({ step, label: `${names[step.step]} ${++counts[step.step]}` }));
}

export function historyResult(step: ReviewStepSummary): string {
	if (step.step === "rework") return `Execution: ${step.executionState}`;
	const labels = {
		passed: "Review passed",
		changes_requested: "Changes requested",
		checks_not_run: "Checks not run",
		error: "Review error",
		pending: "Review in progress",
	};
	return step.summary
		? labels[step.summary.status]
		: `Execution: ${step.executionState} · verdict unavailable`;
}
