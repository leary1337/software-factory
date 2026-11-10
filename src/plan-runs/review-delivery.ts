import type { RunRow } from "../db/schema.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";
import type { ReviewOutcome } from "./review.ts";
import { passedReviewCommit } from "./review-result.ts";

const MAX_ATTEMPTS = 3;
const HEADINGS: Record<ReviewOutcome, string> = {
	passed: "Ревью фабрики: замечаний нет",
	changes_left: "Ревью фабрики: замечания остались после доработок",
	broken: "Ревью фабрики требует внимания владельца",
};
const WAIT: HandleInFlightDecision = { kind: "result", result: { kind: "waiting_for_run" } };

type Events = Awaited<ReturnType<HandleInFlightInput["repos"]["events"]["listByRun"]>>;
export interface ReviewDelivery {
	readonly outcome: ReviewOutcome;
	readonly report: string;
}

/** A new pinned review starts a fresh delivery budget. */
export function currentReviewEvents(events: Events): Events {
	const reversedIndex = [...events]
		.reverse()
		.findIndex((event) => event.kind === "plan_run.review_step");
	return reversedIndex < 0 ? events : events.slice(events.length - reversedIndex);
}

export async function pendingReviewDelivery(
	input: HandleInFlightInput,
	runId: string,
): Promise<ReviewDelivery | null> {
	const events = currentReviewEvents(await input.repos.events.listByRun(runId));
	const event = events.find((event) => event.kind === "plan_run.review_decided");
	return event ? (event.payloadJson as unknown as ReviewDelivery) : null;
}

async function deliverMerge(
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
	if (
		events.filter((event) => event.kind === "plan_run.review_merge_attempt").length >= MAX_ATTEMPTS
	) {
		return {
			outcome: "broken",
			report: `Automatic merge could not be confirmed after ${MAX_ATTEMPTS} attempts. Owner action required.\n\n${delivery.report}`,
		};
	}
	await input.emit(run.id, "plan_run.review_merge_attempt", { reviewedCommit: commit });
	if (!(await input.mergePassedPr(prUrl, run.branch, commit, input.planRun.projectId))) return null;
	await input.emit(run.id, "plan_run.review_merged", { reviewedCommit: commit });
	return delivery;
}

async function deliverComment(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	delivery: ReviewDelivery,
): Promise<ReviewDelivery> {
	const events = currentReviewEvents(await input.repos.events.listByRun(run.id));
	if (!input.commentOnPr || events.some((event) => event.kind === "plan_run.review_commented"))
		return delivery;
	if (
		events.filter((event) => event.kind === "plan_run.review_comment_attempt").length >=
		MAX_ATTEMPTS
	) {
		return {
			outcome: "broken",
			report: `Review comment delivery failed after ${MAX_ATTEMPTS} attempts. Owner action required.\n\n${delivery.report}`,
		};
	}
	const mergeLine = events.some((event) => event.kind === "plan_run.review_merged")
		? ", PR слит автоматически"
		: "";
	await input.emit(run.id, "plan_run.review_comment_attempt", {});
	await input.commentOnPr(
		prUrl,
		`## ${HEADINGS[delivery.outcome]}${mergeLine}\n\n${delivery.report}`,
		`factory-review-${run.id}`,
	);
	await input.emit(run.id, "plan_run.review_commented", {});
	return delivery;
}

/** Persist the decision before I/O; mark completion only after bounded delivery. */
export async function finishReview(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	outcome: ReviewOutcome,
	report: string,
): Promise<HandleInFlightDecision | null> {
	const events = currentReviewEvents(await input.repos.events.listByRun(run.id));
	if (!events.some((event) => event.kind === "plan_run.review_decided")) {
		await input.emit(run.id, "plan_run.review_decided", { outcome, report });
	}
	const merged = await deliverMerge(input, run, prUrl, { outcome, report }, events);
	if (!merged) return WAIT;
	const delivered = await deliverComment(input, run, prUrl, merged);
	await input.emit(run.id, "plan_run.review_finished", {
		planRunId: input.planRun.id,
		seq: input.child.seq,
		...delivered,
	});
	return null;
}
