import { type ReviewMergeResult, readReviewMergeResult } from "../core/review-merge.ts";
import type { RunRow } from "../db/schema.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import type { ReviewDelivery } from "./review-delivery.ts";
import { passedReviewCommit } from "./review-result.ts";
import { MERGE_WAIT_REASONS } from "./review-warren-merge.ts";

const MAX_MERGE_ATTEMPTS = 3;
type Events = Awaited<ReturnType<HandleInFlightInput["repos"]["events"]["listByRun"]>>;

export function latestMergeResult(events: Events): ReviewMergeResult | null {
	const event = [...events]
		.reverse()
		.find((entry) => entry.kind === "plan_run.review_merge_result");
	return readReviewMergeResult(event?.payloadJson);
}

function blockedDelivery(delivery: ReviewDelivery, result: ReviewMergeResult): ReviewDelivery {
	if (result.kind === "merged") return delivery;
	const paths = result.paths?.length ? `\nAffected paths: ${result.paths.join(", ")}` : "";
	return {
		outcome: "broken",
		report: `${result.detail}${paths}\nNext action: ${result.nextAction}\n\n${delivery.report}`,
	};
}

async function attemptMerge(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	commit: string,
): Promise<ReviewMergeResult> {
	try {
		if (!input.mergePassedPr || !run.branch) throw new Error("merge unavailable");
		return await input.mergePassedPr(prUrl, run.branch, commit, input.planRun.projectId);
	} catch {
		// Unclassified failures are not permission to repeat an external mutation.
		return {
			kind: "blocked",
			reason: "unexpected_error",
			detail: "Automatic merge stopped because its result could not be determined.",
			nextAction: "Inspect the pull request and server logs before retrying or merging manually.",
		};
	}
}

/** Persist every result before comment delivery, so a restart cannot retry a policy refusal. */
export async function deliverMerge(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	delivery: ReviewDelivery,
	events: Events,
): Promise<ReviewDelivery | null> {
	const commit = passedReviewCommit(delivery.report);
	if (delivery.outcome !== "passed" || !input.mergePassedPr || !run.branch || !commit)
		return delivery;
	if (events.some((event) => event.kind === "plan_run.review_merged")) return delivery;
	const last = latestMergeResult(events);
	if (last?.kind === "blocked") return blockedDelivery(delivery, last);
	const acknowledgedWaits = events.filter((event) => {
		if (event.kind !== "plan_run.review_merge_result") return false;
		const result = readReviewMergeResult(event.payloadJson);
		return result?.kind === "retry" && MERGE_WAIT_REASONS.has(result.reason);
	}).length;
	// Unacknowledged attempts still count after a crash; only a persisted,
	// classified wait refunds the transport-attempt budget.
	const attempts =
		events.filter((event) => event.kind === "plan_run.review_merge_attempt").length -
		acknowledgedWaits;
	const waits = events.filter((event) => event.kind === "plan_run.review_merge_result").length;
	// A missing check or stuck provider operation must remain bounded across restarts.
	if (waits >= 180) {
		const stopped: ReviewMergeResult = {
			kind: "blocked",
			reason: "merge_wait_exhausted",
			detail: "Automatic merge is still waiting after 180 polls.",
			nextAction: "Inspect missing CI results or a pending branch update, then retry review.",
		};
		await input.emit(run.id, "plan_run.review_merge_result", { ...stopped });
		return blockedDelivery(delivery, stopped);
	}
	if (attempts >= MAX_MERGE_ATTEMPTS) {
		const stopped: ReviewMergeResult = {
			kind: "blocked",
			reason: last?.kind === "retry" ? last.reason : "merge_unconfirmed",
			detail: last?.kind === "retry" ? last.detail : "Automatic merge could not be confirmed.",
			nextAction: `Automatic retries stopped after ${MAX_MERGE_ATTEMPTS} attempts. Inspect the pull request and resolve the reported cause before retrying.`,
		};
		await input.emit(run.id, "plan_run.review_merge_result", { ...stopped });
		return blockedDelivery(delivery, stopped);
	}
	await input.emit(run.id, "plan_run.review_merge_attempt", { reviewedCommit: commit });
	const result = await attemptMerge(input, run, prUrl, commit);
	await input.emit(run.id, "plan_run.review_merge_result", { ...result });
	if (result.kind === "retry") return null;
	if (result.kind === "blocked") return blockedDelivery(delivery, result);
	await input.emit(run.id, "plan_run.review_merged", { reviewedCommit: commit });
	return delivery;
}
