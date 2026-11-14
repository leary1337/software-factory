import type { RunRow } from "../db/schema.ts";
import { recordLearningEvidence } from "../runs/learning-evidence.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";
import type { ReviewOutcome } from "./review.ts";
import { deliverMerge } from "./review-merge-delivery.ts";

const MAX_ATTEMPTS = 3;
const HEADINGS: Record<ReviewOutcome, string> = {
	passed: "Ревью фабрики: замечаний нет",
	changes_left: "Ревью фабрики: замечания остались после доработок",
	broken: "Ревью фабрики требует внимания владельца",
};
const WAIT: HandleInFlightDecision = { kind: "result", result: { kind: "waiting_for_merge" } };

type Events = Awaited<ReturnType<HandleInFlightInput["repos"]["events"]["listByRun"]>>;
export interface ReviewDelivery {
	readonly outcome: ReviewOutcome;
	readonly report: string;
}

/** A new pinned review starts a fresh delivery budget. */
export function currentReviewEvents(events: Events): Events {
	const reversedIndex = [...events]
		.reverse()
		.findIndex(
			(event) =>
				event.kind === "plan_run.review_step" ||
				event.kind === "plan_run.review_retry_requested" ||
				event.kind === "plan_run.review_delivery_retry_requested",
		);
	if (reversedIndex < 0) return events;
	const index = events.length - reversedIndex - 1;
	return events.slice(index + (events[index]?.kind === "plan_run.review_step" ? 1 : 0));
}

export function hasPendingReviewRetry(events: Events): boolean {
	const current = currentReviewEvents(events);
	return (
		current.some((event) => event.kind === "plan_run.review_retry_requested") &&
		!current.some((event) => event.kind === "plan_run.review_decided")
	);
}

export async function pendingReviewDelivery(
	input: HandleInFlightInput,
	runId: string,
): Promise<ReviewDelivery | null> {
	const events = currentReviewEvents(await input.repos.events.listByRun(runId));
	const event = events.find((event) => event.kind === "plan_run.review_decided");
	return event ? (event.payloadJson as unknown as ReviewDelivery) : null;
}

async function deliverComment(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	delivery: ReviewDelivery,
): Promise<ReviewDelivery> {
	const history = await input.repos.events.listByRun(run.id);
	const events = currentReviewEvents(history);
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
	const step = [...history].reverse().find((event) => event.kind === "plan_run.review_step");
	const reviewId = (step?.payloadJson as { stepRunId?: unknown } | undefined)?.stepRunId;
	// Deduplicate retries of this report, not later reviews of the same implementation.
	const recovery = events.find(
		(event) => event.kind === "plan_run.review_delivery_retry_requested",
	);
	const key = `factory-review-${run.id}${typeof reviewId === "string" ? `-${reviewId}` : ""}${recovery ? `-delivery-${recovery.id}` : ""}`;
	await input.emit(run.id, "plan_run.review_comment_attempt", {});
	await input.commentOnPr(
		prUrl,
		`## ${HEADINGS[delivery.outcome]}${mergeLine}\n\n${delivery.report}`,
		key,
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
	if (delivered.outcome !== "passed") {
		const step = [...(await input.repos.events.listByRun(run.id))]
			.reverse()
			.find((event) => event.kind === "plan_run.review_step");
		const source = (step?.payloadJson as { stepRunId?: unknown } | undefined)?.stepRunId;
		const key = typeof source === "string" ? source : run.id;
		await recordLearningEvidence(input.repos, input.emit, run.id, {
			sourceKey: `escalation:${key}:${delivered.outcome}`,
			trigger: "escalation",
			sourceRunId: key,
			projectId: input.planRun.projectId,
			planRunId: input.planRun.id,
			childSeq: input.child.seq,
			report: delivered.report,
		});
	}
	await input.emit(run.id, "plan_run.review_finished", {
		planRunId: input.planRun.id,
		seq: input.child.seq,
		...delivered,
	});
	return null;
}
