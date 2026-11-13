import { summarizeReviewEvidence } from "../core/review-evidence.ts";
import type { ReviewMergeResult } from "../core/review-merge.ts";
import type { ReviewStepSummary } from "../core/review-result.ts";
import { type ReviewRepos, readResultText } from "./review.ts";
import { currentReviewEvents } from "./review-delivery.ts";
import { latestMergeResult } from "./review-merge-delivery.ts";

/** A dispatch failure has no reviewer run, so expose its persisted report on the task. */
export async function loadReviewFailure(repos: ReviewRepos, runId: string): Promise<string | null> {
	const events = currentReviewEvents(await repos.events.listByRun(runId));
	const event = events.find((entry) => entry.kind === "plan_run.review_finished");
	const payload = event?.payloadJson as { outcome?: unknown; report?: unknown } | undefined;
	return payload?.outcome !== "passed" && typeof payload?.report === "string"
		? payload.report
		: null;
}

/** Operator-only latest merge decision for the current reviewed head. */
export async function loadReviewMergeResult(
	repos: ReviewRepos,
	runId: string,
): Promise<ReviewMergeResult | null> {
	return latestMergeResult(currentReviewEvents(await repos.events.listByRun(runId)));
}

/** Operator-only task history, derived from persisted coordinator events. */
export async function loadReviewSummaries(
	repos: ReviewRepos,
	runId: string,
): Promise<ReviewStepSummary[]> {
	const events = await repos.events.listByRun(runId);
	const steps: ReviewStepSummary[] = [];
	for (const event of events) {
		if (event.kind !== "plan_run.review_step") continue;
		const payload = event.payloadJson as {
			step?: unknown;
			stepRunId?: unknown;
			reviewedCommit?: unknown;
		};
		if (
			(payload.step !== "review" && payload.step !== "ui_review" && payload.step !== "rework") ||
			typeof payload.stepRunId !== "string"
		)
			continue;
		const run = await repos.runs.require(payload.stepRunId);
		steps.push({
			runId: run.id,
			step: payload.step,
			executionState: run.state,
			summary:
				payload.step !== "rework"
					? summarizeReviewEvidence(
							await readResultText(repos, run.id),
							run.state,
							run.failureReason,
							typeof payload.reviewedCommit === "string"
								? payload.reviewedCommit
								: (run.baseCommit ?? undefined),
							await repos.events.listByRun(run.id),
						)
					: null,
		});
	}
	return steps;
}
