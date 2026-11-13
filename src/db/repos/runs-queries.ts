/**
 * Read/query run methods (warren-ac7f), extracted from `RunsRepo` to keep
 * `runs.ts` under the file-size budget. Mirrors the `runs-ci-fixer.ts` /
 * `runs-stats.ts` precedent: each method becomes a free function taking the
 * `DrizzleAdapter` as its first argument, and `RunsRepo` delegates to it so
 * the call surface is unchanged.
 */

import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { RunRow, RunState } from "../schema.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

type RunsTable = DrizzleAdapter["schema"]["runs"];

function orderByClause(
	runs: RunsTable,
	_sort: "started" = "started",
	dir: "asc" | "desc" = "desc",
): SQL[] {
	const col = runs.startedAt;
	return [dir === "asc" ? asc(col) : desc(col), asc(runs.id)];
}

export async function listAll(
	adapter: DrizzleAdapter,
	options: {
		limit?: number;
		offset?: number;
		sort?: "started";
		dir?: "asc" | "desc";
	} = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const { limit = 100, offset = 0, sort = "started", dir = "desc" } = options;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.orderBy(...orderByClause(runs, sort, dir))
			.limit(limit)
			.offset(offset),
	);
}

export async function listByProject(
	adapter: DrizzleAdapter,
	projectId: string,
	options: {
		limit?: number;
		offset?: number;
		sort?: "started";
		dir?: "asc" | "desc";
	} = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const { limit = 100, offset = 0, sort = "started", dir = "desc" } = options;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(eq(runs.projectId, projectId))
			.orderBy(...orderByClause(runs, sort, dir))
			.limit(limit)
			.offset(offset),
	);
}

export async function listByAgent(
	adapter: DrizzleAdapter,
	agentName: string,
	options: {
		limit?: number;
		offset?: number;
		sort?: "started";
		dir?: "asc" | "desc";
	} = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const { limit = 100, offset = 0, sort = "started", dir = "desc" } = options;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(eq(runs.agentName, agentName))
			.orderBy(...orderByClause(runs, sort, dir))
			.limit(limit)
			.offset(offset),
	);
}

export async function aggregate(
	adapter: DrizzleAdapter,
	filter: { projectId?: string; agentName?: string } = {},
): Promise<{
	total: number;
}> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const conds: SQL[] = [];
	if (filter.projectId !== undefined) {
		conds.push(eq(runs.projectId, filter.projectId));
	}
	if (filter.agentName !== undefined) {
		conds.push(eq(runs.agentName, filter.agentName));
	}
	const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
	const baseQuery = db
		.select({
			total: sql<number>`count(*)`,
		})
		.from(runs);
	const rows = await adapter.pickAll(where === undefined ? baseQuery : baseQuery.where(where));
	const row = rows[0];
	return {
		total: Number(row?.total ?? 0),
	};
}

export const ANALYTICS_MAX_ROWS = 10_000;

export async function listForAnalytics(
	adapter: DrizzleAdapter,
	filter: { projectId?: string; from?: string; to?: string } = {},
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const conds: SQL[] = [];
	if (filter.projectId !== undefined) {
		conds.push(eq(runs.projectId, filter.projectId));
	}
	if (filter.from !== undefined) {
		conds.push(gte(runs.startedAt, filter.from));
	}
	if (filter.to !== undefined) {
		conds.push(lte(runs.startedAt, filter.to));
	}
	const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
	const baseQuery = db.select().from(runs);
	const filtered = where === undefined ? baseQuery : baseQuery.where(where);
	return adapter.pickAll(filtered.orderBy(desc(runs.startedAt)).limit(ANALYTICS_MAX_ROWS));
}

/**
 * Fetch the rows matching `ids` in a single query. Missing ids are
 * silently omitted — the caller decides whether a partial result is
 * an error. Used by `GET /plan-runs/:id` (warren-f923) to fan child
 * runIds out into the detail payload without an N+1 round-trip.
 */
export async function listByIds(
	adapter: DrizzleAdapter,
	ids: readonly string[],
): Promise<RunRow[]> {
	if (ids.length === 0) return [];
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(inArray(runs.id, ids as string[])),
	);
}

export async function listByState(
	adapter: DrizzleAdapter,
	state: RunState | RunState[],
): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const where = Array.isArray(state) ? inArray(runs.state, state) : eq(runs.state, state);
	return adapter.pickAll(db.select().from(runs).where(where).orderBy(asc(runs.id)));
}

/**
 * The retry run a `sandbox_run_lost` original spawned (warren-4af7), if any.
 * At most one row can exist — the retry decision checks this before
 * dispatching — so a `pickOne` read is exact.
 */
export async function findByRetryOf(
	adapter: DrizzleAdapter,
	runId: string,
): Promise<RunRow | null> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const row = await adapter.pickOne(db.select().from(runs).where(eq(runs.retryOf, runId)));
	return row ?? null;
}

/**
 * Runs whose PR the merge watcher still has to settle (warren-3bc6):
 * `pr_url` is set and `pr_state` is not yet terminal (NULL — never polled,
 * or a historical row — or `open`). Boot re-adoption enumerates these so a
 * restart never orphans an in-flight poll.
 */
export async function listWithUnresolvedPr(adapter: DrizzleAdapter): Promise<RunRow[]> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	return adapter.pickAll(
		db
			.select()
			.from(runs)
			.where(and(isNotNull(runs.prUrl), or(isNull(runs.prState), eq(runs.prState, "open"))))
			.orderBy(asc(runs.id)),
	);
}
