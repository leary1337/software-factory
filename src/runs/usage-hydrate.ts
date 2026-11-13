import type { EventsRepo } from "../db/repos/events.ts";
import type { RunRow, RunState } from "../db/schema.ts";
import { aggregateUsageFromEvents, eventRowToUsageInput } from "./usage-aggregate.ts";

const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Subset of `EventsRepo` used for hydration. Declared structurally so
 * tests can stub the events fetch without instantiating a full repo.
 */
export interface UsageEventsFetcher {
	listUsageEvents(
		runIds: readonly string[],
	): Promise<
		readonly { runId: string; kind: string; stream: string | null; payloadJson: unknown }[]
	>;
}

/**
 * Narrow write seam for hydration. `RunsRepo` satisfies this
 * structurally via `updateUsage`; tests stub it.
 */
export interface UsagePersister {
	updateUsage(
		runId: string,
		stats: {
			tokensInput: number;
			tokensOutput: number;
			tokensCacheRead: number;
			tokensCacheWrite: number;
		},
	): Promise<void>;
}

const ZERO_STATS = {
	tokensInput: 0,
	tokensOutput: 0,
	tokensCacheRead: 0,
	tokensCacheWrite: 0,
};

function zeroStatsFor(run: RunRow): typeof ZERO_STATS {
	// Preserve any bridge-stamped token columns; zero only the nulls.
	return {
		tokensInput: run.tokensInput ?? 0,
		tokensOutput: run.tokensOutput ?? 0,
		tokensCacheRead: run.tokensCacheRead ?? 0,
		tokensCacheWrite: run.tokensCacheWrite ?? 0,
	};
}

function persistUsage(runId: string, stats: typeof ZERO_STATS, persister: UsagePersister): void {
	persister.updateUsage(runId, stats).catch((err: unknown) => {
		console.error(`[usage-hydrate] failed to persist usage for run ${runId}:`, err);
	});
}

export async function backfillTerminalUsage(
	run: RunRow,
	events: UsageEventsFetcher | EventsRepo,
	persister: UsagePersister,
): Promise<void> {
	if (!isHydrationCandidate(run)) return;
	try {
		const rows = await events.listUsageEvents([run.id]);
		const stats = aggregateUsageFromEvents(rows.map(eventRowToUsageInput)) ?? zeroStatsFor(run);
		await persister.updateUsage(run.id, stats);
	} catch (err) {
		console.error(`[usage-hydrate] failed to backfill usage for run ${run.id}:`, err);
	}
}

export async function hydrateRunsUsage<T extends RunRow>(
	runs: readonly T[],
	events: UsageEventsFetcher | EventsRepo,
	persister?: UsagePersister,
): Promise<T[]> {
	const candidates = runs.filter(isHydrationCandidate);
	if (candidates.length === 0) return runs.slice();
	const rows = await events.listUsageEvents(candidates.map((r) => r.id));
	const byRun = new Map<string, (typeof rows)[number][]>();
	for (const row of rows) {
		const bucket = byRun.get(row.runId);
		if (bucket === undefined) byRun.set(row.runId, [row]);
		else bucket.push(row);
	}
	return runs.map((run) => {
		if (!isHydrationCandidate(run)) return run;
		const stats = aggregateUsageFromEvents((byRun.get(run.id) ?? []).map(eventRowToUsageInput));
		if (stats === null) {
			// Zero usage envelopes: persist zeros so this terminal row stops
			// being a candidate on the next read (warren-b33e).
			if (persister) {
				const zeros = zeroStatsFor(run);
				persistUsage(run.id, zeros, persister);
				return { ...run, ...zeros };
			}
			return run;
		}
		if (persister) persistUsage(run.id, stats, persister);
		return {
			...run,
			tokensInput: stats.tokensInput,
			tokensOutput: stats.tokensOutput,
			tokensCacheRead: stats.tokensCacheRead,
			tokensCacheWrite: stats.tokensCacheWrite,
		};
	});
}

/**
 * Single-row convenience wrapper around `hydrateRunsUsage`. Returns the
 * input row unchanged when it's not a hydration candidate.
 */
export async function hydrateRunUsage<T extends RunRow>(
	run: T,
	events: UsageEventsFetcher | EventsRepo,
): Promise<T> {
	const [hydrated] = await hydrateRunsUsage([run], events);
	// Length-1 input ⇒ length-1 output; non-null assertion is safe.
	return hydrated as T;
}

function isHydrationCandidate(run: RunRow): boolean {
	return (
		[run.tokensInput, run.tokensOutput, run.tokensCacheRead, run.tokensCacheWrite].some(
			(value) => value === null,
		) && TERMINAL_RUN_STATES.has(run.state)
	);
}
