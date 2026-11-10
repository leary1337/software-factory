import { summarizeReviewEvidence } from "../core/review-evidence.ts";
import type { ReviewStepSummary } from "../core/review-result.ts";
import { type ReviewRepos, readResultText } from "./review.ts";

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
