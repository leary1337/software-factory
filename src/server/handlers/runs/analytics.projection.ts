/**
 * Public projection for `GET /analytics/runs` (warren-4f6c / pl-b82d step 15;
 * split out of `analytics.ts` to hold the file-size budget).
 *
 * The public analytics body is a run-count and state-distribution view: how
 * much work this instance does, how much of it lands, and how many tokens it
 * burns doing so. Three allowlists, one per nesting level, so a field added
 * to `RunMetrics`, `RunTotals` or `RunGroupBucket` tomorrow is absent from
 * the public body until someone classifies it — see `src/server/projection.ts`.
 */

import type {
	DimensionTokenSeries,
	RunGroupBucket,
	RunMetrics,
	RunOutcomes,
	RunTotals,
	TokenBreakdown,
	TokenDayBucket,
} from "../../../runs/index.ts";
import { isPublicOnly, pickFields } from "../../projection.ts";
import type { Actor } from "../../types.ts";

/**
 * Structured token section added to `GET /analytics/runs` (warren-1244 / pl-d1a2).
 * Groups all token analytics — aggregate totals, per-model/provider summaries,
 * and daily time series — into a single nested object so the UI can render
 * token charts without picking fields off multiple top-level keys.
 */
export interface RunAnalyticsTokensSection {
	/** Aggregate token breakdown across all runs in the window. */
	readonly totals: TokenBreakdown;
	/** Per-model aggregate token totals, sorted by total tokens desc. */
	readonly byModel: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	/** Per-provider aggregate token totals, sorted by total tokens desc. */
	readonly byProvider: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	/** Overall daily token series, one bucket per calendar day (YYYY-MM-DD). */
	readonly timeSeries: readonly TokenDayBucket[];
	/** Per-model daily token series, top-5 + OTHER_KEY fold + NONE_KEY. */
	readonly byModelTimeSeries: readonly DimensionTokenSeries[];
	/** Per-provider daily token series, top-5 + OTHER_KEY fold + NONE_KEY. */
	readonly byProviderTimeSeries: readonly DimensionTokenSeries[];
}

/** The full `GET /analytics/runs` body an operator receives. */
export interface RunAnalyticsBody extends RunMetrics {
	readonly filter: { projectId: string | null; from: string | null; to: string | null };
	readonly tokens: RunAnalyticsTokensSection;

	readonly outcomes: RunOutcomes;
}

/**
 * The `GET /analytics/runs` sections a `readPublic`-only spectator sees
 * (warren-4f6c / pl-b82d step 15). See the module doc above.
 */
export const PUBLIC_RUN_ANALYTICS_FIELDS = [
	"filter",
	"totals",
	"timeSeries",
	"byAgent",
	"byModel",
	"byProvider",
	"byFailureReason",
	"tokenTimeSeries",
	"tokenByModelSeries",
	"tokenByProviderSeries",
	"tokens",
	// warren-bc9c: the delivery timing block — medians over push/PR/merge
	// gaps, same posture as queueWaitMs (load shape, not a private fact).
	"delivery",
	// warren-be04: rates + counts are public (same call as the warren-bd57

	// down — see PUBLIC_COST_PER_MERGED_PR_*_FIELDS below. warren-97ae:

	// public on the overall shape — the buckets keep it redacted because a

	"outcomes",
] as const satisfies readonly (keyof RunAnalyticsBody)[];

/**
 * The complement of `PUBLIC_RUN_ANALYTICS_FIELDS`.
 *
 * - `topSeedsByContext` — a leaderboard of the instance's own issue ids
 *   ranked by context burn. Reads as internal backlog triage, and the
 *   seed ids only mean anything to the operator.
 */
export const REDACTED_RUN_ANALYTICS_FIELDS = [
	"topSeedsByContext",
] as const satisfies readonly (keyof RunAnalyticsBody)[];

export const PUBLIC_RUN_TOTALS_FIELDS = [
	"runs",
	"succeeded",
	"failed",
	"cancelled",
	"active",
	"successRate",
	"durationMs",
	// warren-0af9: queue wait is a load-shape signal (how backed-up the
	// instance is), not a private fact — same posture as durationMs.
	"queueWaitMs",
	// warren-bd57: how much dispatched work actually lands is the public
	// posture's own headline ("how much of it lands") — a rate, not a
	// private fact.
	"prStateKnown",
	"prsMerged",
	"mergedPrRate",
	"contextTokens",
	"tokens",
] as const satisfies readonly (keyof RunTotals)[];

export const REDACTED_RUN_TOTALS_FIELDS = [] as const satisfies readonly (keyof RunTotals)[];

export const PUBLIC_RUN_GROUP_FIELDS = [
	"key",
	"runs",
	"succeeded",
	"failed",
	"cancelled",
	"successRate",
	// warren-bd57: per-bucket landed-work rate, public on the same call as
	// the totals fields.
	"prStateKnown",
	"prsMerged",
	"mergedPrRate",
	"contextTokensTotal",
	"avgContextTokens",
	"tokens",
	"avgDurationMs",
] as const satisfies readonly (keyof RunGroupBucket)[];

export const REDACTED_RUN_GROUP_FIELDS = [] as const satisfies readonly (keyof RunGroupBucket)[];

export type PublicRunOutcomes = RunOutcomes;

export type PublicRunAnalytics = Omit<
	Pick<RunAnalyticsBody, (typeof PUBLIC_RUN_ANALYTICS_FIELDS)[number]>,
	"totals" | "byAgent" | "byModel" | "byProvider" | "outcomes"
> & {
	readonly totals: Pick<RunTotals, (typeof PUBLIC_RUN_TOTALS_FIELDS)[number]>;
	readonly byAgent: readonly Pick<RunGroupBucket, (typeof PUBLIC_RUN_GROUP_FIELDS)[number]>[];
	readonly byModel: readonly Pick<RunGroupBucket, (typeof PUBLIC_RUN_GROUP_FIELDS)[number]>[];
	readonly byProvider: readonly Pick<RunGroupBucket, (typeof PUBLIC_RUN_GROUP_FIELDS)[number]>[];
	readonly outcomes: PublicRunOutcomes;
};

/**
 * Narrow the analytics body for `actor`. The operator gets the body
 * untouched, so the public body is provably the operator body minus
 * fields — one construction site, no drift.
 */
export function projectRunAnalytics(
	body: RunAnalyticsBody,
	actor: Actor | undefined,
): RunAnalyticsBody | PublicRunAnalytics {
	if (!isPublicOnly(actor)) return body;
	const groups = (buckets: readonly RunGroupBucket[]) =>
		buckets.map((b) => pickFields(b, PUBLIC_RUN_GROUP_FIELDS));
	const outcomes: PublicRunOutcomes = {
		steering: body.outcomes.steering,
		autonomy: body.outcomes.autonomy,
	};
	return {
		...pickFields(body, PUBLIC_RUN_ANALYTICS_FIELDS),
		totals: pickFields(body.totals, PUBLIC_RUN_TOTALS_FIELDS),
		byAgent: groups(body.byAgent),
		byModel: groups(body.byModel),
		byProvider: groups(body.byProvider),
		outcomes,
	};
}
