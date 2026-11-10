import { parseVerdict } from "../core/review-result.ts";
import type { TaskMetrics } from "../core/task-metrics.ts";
import type { EventRow, PlanRunChildRow, RunRow } from "../db/schema.ts";

export interface TaskMetricRun {
	readonly run: RunRow;
	readonly events: readonly EventRow[];
}

function dataOf(event: EventRow): Record<string, unknown> {
	return typeof event.payloadJson === "object" && event.payloadJson !== null
		? (event.payloadJson as Record<string, unknown>)
		: {};
}

function valid(value: number | null): value is number {
	return value !== null && Number.isFinite(value) && value >= 0;
}

function timestamp(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function interval(start: number | null, end: number | null): number | null {
	return start !== null && end !== null && end >= start ? end - start : null;
}

function knownSum(values: readonly (number | null)[]): number | null {
	const known = values.filter(valid);
	return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function tokenTotal(run: RunRow): number | null {
	const buckets = [run.tokensInput, run.tokensOutput, run.tokensCacheRead, run.tokensCacheWrite];
	return buckets.every(valid)
		? buckets.reduce<number>((sum, value) => sum + (value ?? 0), 0)
		: null;
}

function reviewSteps(events: readonly EventRow[]): Map<string, string> {
	const steps = new Map<string, string>();
	for (const event of events) {
		const data = dataOf(event);
		if (
			event.kind === "plan_run.review_step" &&
			typeof data.stepRunId === "string" &&
			typeof data.step === "string"
		)
			steps.set(data.stepRunId, data.step);
	}
	return steps;
}

function escalationCount(events: readonly EventRow[]): number {
	const escalations = new Set<string>();
	for (const event of events) {
		const data = dataOf(event);
		if (event.kind === "factory.learning" && data.trigger === "escalation")
			escalations.add(typeof data.sourceKey === "string" ? data.sourceKey : String(event.id));
	}
	return escalations.size;
}

function reviewObservations(events: readonly EventRow[]) {
	const steps = reviewSteps(events);
	const kinds = [...steps.values()];
	const reworkCount = kinds.filter((step) => step === "rework").length;
	const reviewCount = kinds.filter((step) => step === "review").length;
	const uiReviewCount = kinds.filter((step) => step === "ui_review").length;
	const changed = events.some((event) => {
		const data = dataOf(event);
		return (
			steps.has(event.runId) &&
			data.type === "result" &&
			typeof data.result === "string" &&
			parseVerdict(data.result) === "CHANGES"
		);
	});
	const newestFirst = [...events].reverse();
	// Delivery can fail after a successful review. Prefer its pre-delivery decision.
	const result =
		newestFirst.find((event) => event.kind === "plan_run.review_decided") ??
		newestFirst.find((event) => event.kind === "plan_run.review_finished");
	const outcome = result ? dataOf(result).outcome : null;
	const firstPass = outcome === "passed" ? true : outcome === "changes_left" ? false : null;
	return {
		reviewCount,
		uiReviewCount,
		reworkCount,
		firstPass:
			changed || reworkCount > 0 || reviewCount > 1 || uiReviewCount > 1 ? false : firstPass,
		escalationCount: escalationCount(events),
	};
}

/** Aggregate persisted facts; a reviewer is part of the same task even though it opens no PR. */
export function aggregateTaskMetrics(
	child: Pick<PlanRunChildRow, "state" | "startedAt" | "endedAt">,
	entries: readonly TaskMetricRun[],
	missingRunCount = 0,
	incomplete = false,
	now = Date.now(),
): TaskMetrics {
	const runs = [...new Map(entries.map((entry) => [entry.run.id, entry])).values()];
	const events = runs
		.flatMap((entry) => entry.events)
		.sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
	const costs = runs.map(({ run }) => (valid(run.costUsd) ? run.costUsd : null));
	const tokens = runs.map(({ run }) => tokenTotal(run));
	const durations = runs.map(({ run }) =>
		interval(
			timestamp(run.startedAt),
			timestamp(run.endedAt) ?? (run.state === "running" ? now : null),
		),
	);
	const created = runs.map(({ run }) => run.createdAt).filter(valid);
	const start = created.length > 0 ? Math.min(...created) : timestamp(child.startedAt);
	const end = timestamp(child.endedAt);
	const review = reviewObservations(events);
	return {
		runCount: runs.length,
		missingRunCount,
		incomplete: incomplete || missingRunCount > 0,
		costUsd: knownSum(costs),
		costUnknownRuns: costs.filter((value) => value === null).length + missingRunCount,
		subscriptionEstimateRuns: runs.filter(({ run }) => run.costBasis === "subscription_estimate")
			.length,
		totalTokens: knownSum(tokens),
		tokenUnknownRuns: tokens.filter((value) => value === null).length + missingRunCount,
		activeMs: knownSum(durations),
		durationUnknownRuns: durations.filter((value) => value === null).length + missingRunCount,
		elapsedMs: interval(
			start,
			end ?? (["merged", "failed", "skipped"].includes(child.state) ? null : now),
		),
		deliveryMs: child.state === "merged" ? interval(start, end) : null,
		...review,
		firstPass:
			(incomplete || missingRunCount > 0) && review.firstPass !== false ? null : review.firstPass,
		steeringCount: events.filter((event) => event.kind === "steer.sent").length,
		resumeCount: events.filter((event) => event.kind === "plan_run.resumed").length,
		postMergeIncidentCount: events.filter((event) => event.kind === "plan_run.deployment_incident")
			.length,
	};
}
