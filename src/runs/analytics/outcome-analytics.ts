import type { InsightConfidence } from "../../core/wire.ts";
import type { RunMetrics, RunMetricsRow } from "./run-metrics.ts";

/**
 * Event kind emitted by `steerRun` when a steering message is forwarded to
 * the burrow inbox. Mirrored here (as in `insights.ts`) so the analytics
 * layer does not import from the run-lifecycle module.
 */
const STEER_SENT_KIND = "steer.sent";

/**
 * The minimal steering-event shape this aggregator needs — only the run id
 * matters, so callers can pass full `EventRow`s without a cast.
 */
export interface SteeringOutcomeEventRow {
	readonly runId: string;
	readonly kind: string;
}

/** Outcome tallies for one cohort of runs (steered, unsteered, or all). */
export interface OutcomeTally {
	/** rows in the cohort. */
	readonly runs: number;
	/** succeeded + failed + cancelled — the success-rate denominator. */
	readonly terminal: number;
	readonly succeeded: number;
	/** succeeded / terminal, or null when no terminal runs. */
	readonly successRate: number | null;
	/**
	 * rows whose `prState` the merge watcher resolved — THE merge-rate
	 * denominator. NULL `prState` rows are unknown and excluded.
	 */
	readonly prStateKnown: number;
	readonly prsMerged: number;
	/** prsMerged / prStateKnown, or null when nothing resolved. */
	readonly mergedPrRate: number | null;
}

/** Steered-versus-unsteered outcome comparison over the analytics window. */
export interface SteeringOutcomeComparison {
	readonly steered: OutcomeTally;
	readonly unsteered: OutcomeTally;
	/**
	 * `steered.mergedPrRate - unsteered.mergedPrRate` (signed, -1..1), or
	 * null unless BOTH cohorts have a resolved-PR denominator.
	 */
	readonly mergedPrRateDelta: number | null;
	/**
	 * Confidence in the comparison, derived from the SMALLER cohort's
	 * `prStateKnown` — the number that bounds the delta's meaning.
	 */
	readonly confidence: InsightConfidence;
}

/** The structured `outcomes` section on `GET /analytics/runs` + `/analytics/behavior`. */
export interface RunOutcomes {
	readonly steering: SteeringOutcomeComparison;
	/**
	 * Autonomy rollup (warren-bc9c): how many of the merged runs needed no
	 * human in the loop — no steering, no infra-retry, no continuation.
	 * "No human commit" is not observable through the Forge seam and is
	 * deliberately out of scope.
	 */
	autonomy: AutonomyRollup;
}

/** Merged count and the unsteered, first-attempt subset of it. */
export interface AutonomyRollup {
	/** rows whose `prState` is `merged` — the rate's denominator. */
	readonly merged: number;
	/** merged rows that were never steered and are first attempts. */
	readonly autonomous: number;
	/** autonomous / merged, or null when nothing merged. */
	rate: number | null;
}

/** Sample size at or above which a denominator earns "medium" confidence. */
export const CONFIDENCE_MEDIUM_SAMPLE = 10;
/** Sample size at or above which a denominator earns "high" confidence. */
export const CONFIDENCE_HIGH_SAMPLE = 30;

/** Qualify a denominator-driven number by the size of the sample behind it. */
export function confidenceForSample(sample: number): InsightConfidence {
	if (sample >= CONFIDENCE_HIGH_SAMPLE) return "high";
	if (sample >= CONFIDENCE_MEDIUM_SAMPLE) return "medium";
	return "low";
}

function tallyRows(rows: readonly RunMetricsRow[]): OutcomeTally {
	let terminal = 0;
	let succeeded = 0;
	let prStateKnown = 0;
	let prsMerged = 0;
	for (const r of rows) {
		if (r.state === "succeeded" || r.state === "failed" || r.state === "cancelled") {
			terminal += 1;
			if (r.state === "succeeded") succeeded += 1;
		}
		if (r.prState !== null) {
			prStateKnown += 1;
			if (r.prState === "merged") prsMerged += 1;
		}
	}
	return {
		runs: rows.length,
		terminal,
		succeeded,
		successRate: terminal === 0 ? null : succeeded / terminal,
		prStateKnown,
		prsMerged,
		mergedPrRate: prStateKnown === 0 ? null : prsMerged / prStateKnown,
	};
}

/**
 * Split `rows` into steered / unsteered cohorts by the `steer.sent` event
 * trace and tally each cohort's outcomes. O(rows + events).
 */
export function buildSteeringOutcomeComparison(
	rows: readonly RunMetricsRow[],
	steeringEvents: readonly SteeringOutcomeEventRow[],
): SteeringOutcomeComparison {
	const steeredIds = new Set<string>();
	for (const e of steeringEvents) {
		if (e.kind === STEER_SENT_KIND) steeredIds.add(e.runId);
	}
	const steered: RunMetricsRow[] = [];
	const unsteered: RunMetricsRow[] = [];
	for (const r of rows) {
		if (steeredIds.has(r.runId)) steered.push(r);
		else unsteered.push(r);
	}
	const s = tallyRows(steered);
	const u = tallyRows(unsteered);
	return {
		steered: s,
		unsteered: u,
		mergedPrRateDelta:
			s.mergedPrRate === null || u.mergedPrRate === null ? null : s.mergedPrRate - u.mergedPrRate,
		confidence: confidenceForSample(Math.min(s.prStateKnown, u.prStateKnown)),
	};
}

/**
 * Autonomy rollup (warren-bc9c): of the runs that merged, how many were
 * never steered (`steer.sent` trace) and were first attempts — no
 * `retry_of` back-link and no `parent_run_id` continuation. O(rows + events).
 */
function buildAutonomy(
	rows: readonly RunMetricsRow[],
	steeringEvents: readonly SteeringOutcomeEventRow[],
): AutonomyRollup {
	const steeredIds = new Set<string>();
	for (const e of steeringEvents) {
		if (e.kind === STEER_SENT_KIND) steeredIds.add(e.runId);
	}
	let merged = 0;
	let autonomous = 0;
	for (const r of rows) {
		if (r.prState !== "merged") continue;
		merged += 1;
		if (!steeredIds.has(r.runId) && r.retryOf === null && r.parentRunId === null) {
			autonomous += 1;
		}
	}
	return { merged, autonomous, rate: merged === 0 ? null : autonomous / merged };
}

/**
 * Build the full outcome-joined rollup for an analytics window from the
 * flat run rows, their steering event trace, and the run-metrics rollup.
 */
export function buildRunOutcomes(
	rows: readonly RunMetricsRow[],
	steeringEvents: readonly SteeringOutcomeEventRow[],
	_metrics: RunMetrics,
): RunOutcomes {
	return {
		steering: buildSteeringOutcomeComparison(rows, steeringEvents),
		autonomy: buildAutonomy(rows, steeringEvents),
	};
}
