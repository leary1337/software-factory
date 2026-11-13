import { gt, sql } from "drizzle-orm";
import { OPS_WINDOW_MS, type OpsWindow, type RunState } from "../core/wire.ts";
import type { SqliteDrizzleDb } from "../db/client.ts";
import type { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { countRunsByState } from "../db/repos/runs-stats.ts";
import type { RuntimeProviderKind } from "../runtime/contract.ts";

/** Run lifecycle counts, dense across `RUN_STATES`. */
export interface OpsRunCounts {
	readonly byState: Readonly<Record<RunState, number>>;
	/** `queued` + `running` — runs still occupying an admission slot. */
	readonly nonTerminal: number;
	readonly total: number;
}

/** Delivery stats — what reap handed to the forge. */
export interface OpsDelivery {
	/**
	 * Runs whose reap measured a pushed branch (reap-time outcome facts
	 * recorded — the branch push ran far enough to be diffed). Null
	 * `commits_ahead` is "unknown", never "no push", so it is excluded.
	 */
	readonly branchesPushed: number;
	/** Runs with a `pr_url` — auto-open landed. */
	readonly prsOpened: number;
	/** Runs whose merge watcher recorded `pr_state = "merged"`. */
	readonly prsMerged: number;
}

/** Cheap control-plane service-health facts (no probes — derived truth). */
export interface OpsServices {
	readonly dbReachable: boolean;
	readonly runtime: RuntimeProviderKind;
	/** Global lifecycle stream (`GET /events/stream`) is wired at boot. */
	readonly lifecycleStream: boolean;
}

/** Full operator snapshot served by `GET /ops/overview`. */
export interface OpsOverview {
	readonly runs: OpsRunCounts;

	readonly window: OpsWindow;
	readonly delivery: OpsDelivery;
	readonly services: OpsServices;
	/** ISO8601 instant the snapshot was taken. */
	readonly generatedAt: string;
}

/** Facts the handler derives from `ServerDeps` and injects. */
export interface OpsServiceFacts {
	readonly runtime: RuntimeProviderKind;
	readonly lifecycleStream: boolean;
}

/** An `OpsOverview` with every db-backed section zeroed. */
export function degradedOpsOverview(
	facts: OpsServiceFacts,
	now: Date,
	window: OpsWindow = "24h",
): OpsOverview {
	return {
		runs: {
			byState: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
			nonTerminal: 0,
			total: 0,
		},
		window,
		delivery: { branchesPushed: 0, prsOpened: 0, prsMerged: 0 },
		services: {
			dbReachable: false,
			runtime: facts.runtime,
			lifecycleStream: facts.lifecycleStream,
		},
		generatedAt: now.toISOString(),
	};
}

/**
 * Build the snapshot. Any db failure collapses to the degraded shape
 * (`services.dbReachable: false`) rather than a partial body — the operator
 * console must never read zero counters as "quiet instance" when the truth
 * is "no database".
 */
export interface BuildOpsOverviewOptions {
	readonly window?: OpsWindow;
	readonly now?: Date;
}

export async function buildOpsOverview(
	adapter: DrizzleAdapter | undefined,
	facts: OpsServiceFacts,
	options: BuildOpsOverviewOptions = {},
): Promise<OpsOverview> {
	const { window = "24h", now = new Date() } = options;
	if (adapter === undefined) return degradedOpsOverview(facts, now, window);
	try {
		const [byState, delivery] = await Promise.all([
			countRunsByState(adapter),
			aggregateDelivery(adapter, now.getTime(), window),
		]);
		const total = Object.values(byState).reduce((a, b) => a + b, 0);
		const nonTerminal = (byState.queued ?? 0) + (byState.running ?? 0);
		return {
			runs: { byState, nonTerminal, total },
			window,
			delivery,
			services: {
				dbReachable: true,
				runtime: facts.runtime,
				lifecycleStream: facts.lifecycleStream,
			},
			generatedAt: now.toISOString(),
		};
	} catch {
		return degradedOpsOverview(facts, now);
	}
}

async function aggregateDelivery(
	adapter: DrizzleAdapter,
	nowMs: number,
	window: OpsWindow,
): Promise<OpsDelivery> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const [row] = await adapter.pickAll<{
		branchesPushed: number | string;
		prsOpened: number | string;
		prsMerged: number | string;
	}>(
		db
			.select({
				branchesPushed: sql<number>`count(${runs.commitsAhead})`.as("branchesPushed"),
				prsOpened: sql<number>`count(${runs.prUrl})`.as("prsOpened"),
				prsMerged: sql<number>`count(*) filter (where ${runs.prState} = 'merged')`.as("prsMerged"),
			})
			.from(runs)
			.where(gt(runs.createdAt, nowMs - OPS_WINDOW_MS[window])),
	);
	return {
		branchesPushed: Number(row?.branchesPushed ?? 0),
		prsOpened: Number(row?.prsOpened ?? 0),
		prsMerged: Number(row?.prsMerged ?? 0),
	};
}
