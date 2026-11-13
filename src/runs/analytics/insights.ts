import type { InsightConfidence } from "../../core/wire.ts";
import type { CommandMining, CommandStat } from "./command-mining.ts";
import type { ContextWasteProxy } from "./context-waste.ts";
import type { DirectoryDifficulty } from "./directory-difficulty.ts";
import { contextWasteProxy } from "./insights-context-waste.ts";
import { hardestDirectory } from "./insights-directory.ts";
import type { RunOutcomes } from "./outcome-analytics.ts";
import type { RunGroupBucket, RunMetrics } from "./run-metrics.ts";

// The confidence vocabulary is canonical in the wire kernel (warren-be04);
// re-exported here so insight consumers keep one import site.
export type { InsightConfidence } from "../../core/wire.ts";

export type InsightSeverity = "info" | "warning" | "critical";

export type InsightKind =
	| "highest-context-seed"
	| "worst-success-agent"
	| "most-failed-command"
	| "most-retried-command"
	| "steering-anomaly"
	| "steering-outcome-delta"
	| "context-waste-proxy"
	| "hardest-directory";

export interface Insight {
	readonly kind: InsightKind;
	readonly severity: InsightSeverity;
	/** short headline for the callout card. */
	readonly title: string;
	/** one-line explanation with the concrete numbers. */
	readonly detail: string;

	readonly value: number;
	/** the subject (seedId / agent / command / model), or null when global. */
	readonly subject: string | null;
	/**
	 * The count `value` was divided by (warren-be04). Outcome-joined
	 * callouts ship every rate/ratio with its denominator so the UI can
	 * render "12 of 34" next to "35%". Absent on count-shaped callouts.
	 */
	readonly denominator?: number;
	/**
	 * Confidence qualifier for outcome-joined callouts (warren-be04),
	 * derived from the sample behind `denominator`. Absent on callouts
	 * whose number is a raw count rather than a rate or ratio.
	 */
	readonly confidence?: InsightConfidence;
}

/**
 * Steering counters a caller may tally while scanning events. All optional —
 * when omitted (or zeroed) the steering insight is skipped. The
 * `GET /analytics/behavior` handler supplies this bundle (built by
 * `buildSteeringSignals`), so the steering insight is live there.
 */
export interface SteeringSignals {
	readonly totalRuns: number;
	/** runs that received at least one mid-run steering message. */
	readonly runsSteered: number;
	/** total steering messages injected across all runs. */
	readonly steeringMessages: number;
}

export interface InsightsInput {
	readonly metrics: RunMetrics;
	readonly mining: CommandMining;
	readonly steering?: SteeringSignals;

	readonly outcomes?: RunOutcomes;
	/**
	 * Context-waste proxy rollup (warren-6d41) — tool_result byte shares
	 * against run context tokens from the `tool_calls` rollup. When
	 * supplied, `buildInsights` also derives the `context-waste-proxy`
	 * callout. The `GET /analytics/behavior` handler supplies it.
	 */
	readonly contextWaste?: ContextWasteProxy;
	/**
	 * Per-directory difficulty rollup (warren-8f1b). Optional like
	 * `steering`: when omitted the `hardest-directory` callout is
	 * skipped. Directories carry their own denominators + confidence.
	 */
	readonly directories?: DirectoryDifficulty;
}

/** Minimum terminal runs before an agent's success rate is worth flagging. */
const MIN_AGENT_TERMINAL_RUNS = 3;
/** Success-rate thresholds for the worst-success-agent callout. */
const AGENT_CRITICAL_SUCCESS_RATE = 0.5;
const AGENT_WARNING_SUCCESS_RATE = 0.8;
/** A seed dominates when its context total is this multiple of the runner-up. */
const SEED_DOMINANCE_FACTOR = 2;
/** Failure-count thresholds for the most-failed-command callout. */
const COMMAND_CRITICAL_FAILURES = 5;
const COMMAND_WARNING_FAILURES = 2;
/** Stuck-score thresholds for the most-retried-command callout. */
const COMMAND_CRITICAL_STUCK = 3;
/** Share-of-runs thresholds for the steering anomaly. */
const STEERING_CRITICAL_SHARE = 0.5;
const STEERING_WARNING_SHARE = 0.25;
/** Minimum resolved-PR rows per cohort before a delta is worth reporting. */
const MIN_OUTCOME_COHORT_KNOWN = 3;
const KIND_ORDER: readonly InsightKind[] = [
	"worst-success-agent",
	"most-retried-command",
	"most-failed-command",
	"steering-outcome-delta",
	"steering-anomaly",
	"context-waste-proxy",
	"hardest-directory",
	"highest-context-seed",
];

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

function pct(rate: number): string {
	return `${Math.round(rate * 100)}%`;
}

function highestContextSeed(metrics: RunMetrics): Insight | null {
	const [top, second] = metrics.topSeedsByContext;
	if (top === undefined || top.contextTokensTotal <= 0) return null;
	const dominant =
		second !== undefined &&
		second.contextTokensTotal > 0 &&
		top.contextTokensTotal >= second.contextTokensTotal * SEED_DOMINANCE_FACTOR;
	return {
		kind: "highest-context-seed",
		severity: dominant ? "warning" : "info",
		title: "Highest-context seed",
		detail: `Seed ${top.seedId} burned ${top.contextTokensTotal} context tokens across ${top.runs} run(s)${
			dominant ? " — far more than any other seed" : ""
		}.`,
		value: top.contextTokensTotal,
		subject: top.seedId,
	};
}

/** Terminal-run count: succeeded + failed + cancelled. */
function terminalRuns(g: RunGroupBucket): number {
	return g.succeeded + g.failed + g.cancelled;
}

function worstSuccessAgent(metrics: RunMetrics): Insight | null {
	let worst: RunGroupBucket | null = null;
	for (const g of metrics.byAgent) {
		if (g.successRate === null || terminalRuns(g) < MIN_AGENT_TERMINAL_RUNS) continue;
		if (worst === null || g.successRate < (worst.successRate ?? 1)) worst = g;
	}
	if (worst === null || worst.successRate === null) return null;
	if (worst.successRate >= AGENT_WARNING_SUCCESS_RATE) return null;
	return {
		kind: "worst-success-agent",
		severity: worst.successRate < AGENT_CRITICAL_SUCCESS_RATE ? "critical" : "warning",
		title: "Worst-performing agent",
		detail: `Agent "${worst.key}" succeeded in only ${pct(worst.successRate)} of ${terminalRuns(
			worst,
		)} terminal run(s).`,
		value: worst.successRate,
		subject: worst.key,
	};
}

function mostFailedCommand(mining: CommandMining): Insight | null {
	const top = mining.byFailures[0];
	if (top === undefined || top.failures < COMMAND_WARNING_FAILURES) return null;
	return {
		kind: "most-failed-command",
		severity: top.failures >= COMMAND_CRITICAL_FAILURES ? "critical" : "warning",
		title: "Most-failed command",
		detail: `"${top.command}" failed ${top.failures} of ${top.invocations} invocation(s)${
			top.osEco ? " (os-eco tooling)" : ""
		}.`,
		value: top.failures,
		subject: top.command,
	};
}

function mostRetriedCommand(mining: CommandMining): Insight | null {
	const top: CommandStat | undefined = mining.byStuckScore[0];
	if (top === undefined || top.stuckScore <= 0) return null;
	return {
		kind: "most-retried-command",
		severity: top.stuckScore >= COMMAND_CRITICAL_STUCK ? "critical" : "warning",
		title: "Stuck-command loop",
		detail: `"${top.command}" was re-run after failing and failed again ${top.stuckScore} time(s) (${top.retries} retr${
			top.retries === 1 ? "y" : "ies"
		}).`,
		value: top.stuckScore,
		subject: top.command,
	};
}

function steeringAnomaly(s: SteeringSignals): Insight | null {
	if (s.totalRuns <= 0 || s.runsSteered <= 0) return null;
	const share = s.runsSteered / s.totalRuns;
	if (share < STEERING_WARNING_SHARE) return null;
	return {
		kind: "steering-anomaly",
		severity: share >= STEERING_CRITICAL_SHARE ? "critical" : "warning",
		title: "Heavy mid-run steering",
		detail: `${s.runsSteered} of ${s.totalRuns} run(s) (${pct(share)}) needed mid-run steering — ${s.steeringMessages} message(s) total.`,
		value: share,
		subject: null,
	};
}

/**
 * Steered-versus-unsteered merged-PR rate delta (warren-be04). Fires only
 * when BOTH cohorts have at least {@link MIN_OUTCOME_COHORT_KNOWN} runs with
 * a resolved `prState` — below that the delta is noise. A negative delta
 * (steered runs land LESS often) is a warning; a non-negative one is info.
 * NULL `prState` rows sit in neither denominator.
 */
function steeringOutcomeDelta(outcomes: RunOutcomes): Insight | null {
	const { steered, unsteered, mergedPrRateDelta, confidence } = outcomes.steering;
	if (mergedPrRateDelta === null) return null;
	if (
		steered.prStateKnown < MIN_OUTCOME_COHORT_KNOWN ||
		unsteered.prStateKnown < MIN_OUTCOME_COHORT_KNOWN
	) {
		return null;
	}
	const steeredRate = steered.mergedPrRate;
	const unsteeredRate = unsteered.mergedPrRate;
	if (steeredRate === null || unsteeredRate === null) return null;
	const signed = `${mergedPrRateDelta >= 0 ? "+" : ""}${Math.round(mergedPrRateDelta * 100)}pts`;
	return {
		kind: "steering-outcome-delta",
		severity: mergedPrRateDelta < 0 ? "warning" : "info",
		title: "Steering-outcome delta",
		detail:
			`Steered runs merged ${steered.prsMerged} of ${steered.prStateKnown} resolved PR(s) ` +
			`(${pct(steeredRate)}); unsteered runs merged ${unsteered.prsMerged} of ` +
			`${unsteered.prStateKnown} (${pct(unsteeredRate)}) — a ${signed} delta.`,
		value: mergedPrRateDelta,
		subject: null,
		denominator: steered.prStateKnown + unsteered.prStateKnown,
		confidence,
	};
}

function compareInsights(a: Insight, b: Insight): number {
	const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
	if (sev !== 0) return sev;
	return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
}

/**
 * Event kind emitted by `steerRun` when a steering message is forwarded to
 * the burrow inbox. Mirrored here so the analytics layer does not import from
 * the run-lifecycle module.
 */
const STEER_SENT_KIND = "steer.sent";

/**
 * The minimal event shape the steering-signals aggregator needs. Matches the
 * subset of `EventRow` used here so callers can pass the full row without an
 * explicit cast.
 */
export interface SteeringEventRow {
	readonly runId: string;
	readonly kind: string;
}

/**
 * Aggregate steering counters from the raw event rows produced by
 * `EventsRepo.listSteeringEventsForRuns`. Returns a populated
 * {@link SteeringSignals} bundle ready to pass to {@link buildInsights}.
 *
 * Complexity is O(n) in the number of event rows.
 *
 * @param rows - Events with kind `steer.sent` for all runs in the analytics
 *   window.
 * @param totalRuns - Total run count in the window (denominator for rates).
 */
export function buildSteeringSignals(
	rows: readonly SteeringEventRow[],
	totalRuns: number,
): SteeringSignals {
	const steeredRunIds = new Set<string>();
	let steeringMessages = 0;
	for (const row of rows) {
		if (row.kind === STEER_SENT_KIND) {
			steeredRunIds.add(row.runId);
			steeringMessages++;
		}
	}
	return {
		totalRuns,
		runsSteered: steeredRunIds.size,
		steeringMessages,
	};
}

/**
 * Per-run steering-message counts (warren-8f1b): the same `steer.sent`
 * scan as {@link buildSteeringSignals}, keyed by run id, for aggregators
 * that join steering to a per-run subject (the directory difficulty map).
 */
export function countSteeringByRun(rows: readonly SteeringEventRow[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.kind !== STEER_SENT_KIND) continue;
		counts.set(row.runId, (counts.get(row.runId) ?? 0) + 1);
	}
	return counts;
}

/**
 * Distill the run-metrics + command-mining rollups (and optional steering
 * signals) into a ranked list of severity-coded callouts. Returns `[]` for a
 * healthy, low-signal window. O(groups + commands) — a handful of single
 * passes over the already-aggregated breakdowns.
 */
export function buildInsights(input: InsightsInput): Insight[] {
	const { metrics, mining, steering, directories, outcomes } = input;
	const candidates: (Insight | null)[] = [
		highestContextSeed(metrics),
		worstSuccessAgent(metrics),
		mostFailedCommand(mining),
		mostRetriedCommand(mining),
	];
	if (steering !== undefined) {
		candidates.push(steeringAnomaly(steering));
	}
	if (outcomes !== undefined) {
		candidates.push(steeringOutcomeDelta(outcomes));
	}
	if (directories !== undefined) {
		candidates.push(hardestDirectory(directories));
	}
	if (input.contextWaste !== undefined) {
		candidates.push(contextWasteProxy(input.contextWaste));
	}
	const insights = candidates.filter((i): i is Insight => i !== null);
	insights.sort(compareInsights);
	return insights;
}
