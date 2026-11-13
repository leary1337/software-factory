import { ValidationError } from "../../../core/errors.ts";
import type { DispatchFacts } from "../../../db/repos/dispatch-context.ts";
import { readProviderFrontmatter } from "../../../registry/index.ts";
import type { RunRow } from "../../../runs/index.ts";
import { hydrateRunsUsage, hydrateRunUsage } from "../../../runs/index.ts";
import { isPublicOnly, pickFields } from "../../projection.ts";
import { jsonResponse } from "../../response.ts";
import type { Actor, RouteHandler, ServerDeps } from "../../types.ts";
import { requireParam } from "../index.ts";

export const PUBLIC_RUN_FIELDS = [
	"id",
	"agentName",
	"projectId",
	"seedId",
	"parentRunId",
	"cloneKind",
	// warren-4af7: the infra-lost retry back-link — a run-id back-reference of
	// the same class as parentRunId, safe for spectators.
	"retryOf",
	"mode",
	"state",
	"failureReason",
	// warren-0af9: the queued instant — a load-shape timestamp, public for
	// the same reason startedAt/endedAt are.
	"createdAt",
	"startedAt",
	"endedAt",
	// warren-7116: the stage timestamps decompose the run wall clock into its
	// four observed edges (workspace ready / agent ready / agent ended / reaped).
	// Load-shape timestamps of the same spectator class as startedAt/endedAt;
	// NULL reads as "never observed" (pre-column rows, never-claimed runs).
	"workspaceReadyAt",
	"agentReadyAt",
	"agentEndedAt",
	"reapedAt",
	"prompt",
	"trigger",
	"prUrl",
	"targetBranch",
	// warren-5255: the composed workspace branch frozen at dispatch — a
	// branch name carrying the run id, same spectator class as salvageRef.
	"branch",
	// warren-afeb: the dispatch-supplied clone ref — a branch/tag/SHA name of
	// the same class as targetBranch and salvageRef, safe for spectators.
	"ref",
	// warren-aaf7: the base-commit pin — a SHA of the same spectator class as
	// ref/targetBranch (a name in the public repo's history).
	"baseCommit",
	// warren-b19e: the resolved workspace base SHA — the merge-base read at
	// reap where commits_ahead is measured. A SHA of the same spectator
	// class as baseCommit; NULL = never measured (pre-column rows, skipped
	// finalize, unpinnable diff base).
	"baseSha",
	// warren-cd3b: the rescue ref is operator-recovery metadata (a branch name
	// carrying the run id, which is already public) — safe for spectators.
	"salvageRef",
	// warren-2ede: the declared provider/model frozen at dispatch. Already
	// spectator-visible as the byModel/byProvider analytics bucket keys, so
	// the per-run copy carries no new information.
	"provider",
	"model",
	// warren-3bc6: the merge watcher's PR facts. `prUrl` is already public
	// and the PR lifecycle is visible to anyone who can open that URL, so
	// the projected copy carries no new information. NULL reads as
	// "unknown" (historical rows, or no PR), never "not merged".
	"prState",
	"prMergedAt",
	// warren-ab2b: reap-time measured outcome facts (commits ahead of base +
	// parsed diff totals). Load-shape metrics of the same class as the token
	// counts; NULL means unknown (pre-column rows, unmeasured finalize).
	"commitsAhead",
	"filesChanged",
	"insertions",
	"deletions",
	"tokensInput",
	"tokensOutput",
	"tokensCacheRead",
	"tokensCacheWrite",
	"previewState",
	"previewPort",
	"previewStartedAt",
	"previewLastHitAt",
] as const satisfies readonly (keyof RunRow)[];

/**
 * The complement of `PUBLIC_RUN_FIELDS`, spelled out so the classification
 * is a decision on record rather than "whatever fell off the list", and so
 * `lifecycle.projection.test.ts` can assert the two partition `RunRow`.
 *
 * - `renderedAgentJson` — the fully rendered system prompt. Prompt
 *   engineering is the IP here, and it is pure noise to a spectator.
 * - `sandboxId` / `sandboxRunId` / `workerId` — internal runtime handles.
 *   They also render as empty "—" cards on the K8s instance today.
 * - `previewFailureMessage` — free text carrying a subprocess stderr tail.
 * - `salvagePath` — a host filesystem path (warren-cd3b); internal topology,
 *   same posture as the runtime handles.
 */
export const REDACTED_RUN_FIELDS = [
	"renderedAgentJson",
	"sandboxId",
	"sandboxRunId",
	"workerId",
	"previewFailureMessage",
	"salvagePath",
] as const satisfies readonly (keyof RunRow)[];

/** A run row as a `readPublic`-only caller sees it. */
export type PublicRun = Pick<RunRow, (typeof PUBLIC_RUN_FIELDS)[number]>;

/**
 * Narrow one run row for `actor`. The operator gets the row untouched, so
 * the public body is provably the operator body minus fields — there is
 * only one construction site and the two cannot drift.
 *
 * Exported (warren-c405) because `GET /plan-runs/:id` fans out `runs[]` too
 * and must reuse THIS function rather than grow a second projection: the
 * plan-run detail handler served raw `RunRow`s to spectators until scenario
 * 39 caught it.
 */
export function projectRun<T extends RunRow>(run: T, actor: Actor | undefined): T | PublicRun {
	return isPublicOnly(actor) ? pickFields(run, PUBLIC_RUN_FIELDS) : run;
}

function parseRunsSort(ctx: { url: URL }): { sort: "started"; dir: "asc" | "desc" } {
	const rawSort = ctx.url.searchParams.get("sort");
	const rawDir = ctx.url.searchParams.get("dir");
	const sort: "started" = "started";
	if (rawSort !== null && rawSort !== "started") {
		throw new ValidationError("?sort must be 'started'");
	}
	let dir: "asc" | "desc" = "desc";
	if (rawDir !== null) {
		if (rawDir !== "asc" && rawDir !== "desc") {
			throw new ValidationError(`?dir must be 'asc' or 'desc'; got '${rawDir}'`);
		}
		dir = rawDir;
	}
	return { sort, dir };
}

/**
 * Parse `?limit` / `?offset` for the runs list (warren-ee50 / pl-b0c0
 * step 1). Defaults preserve the historical 100-row window so existing
 * consumers stay byte-compatible; `limit` is clamped to a sane range
 * to keep a paginated UI honest and the server cheap. `offset` is
 * non-negative; the caller is responsible for stitching pages on its
 * end (no opaque cursor — the predicates here are stable + the
 * `runs.id` tiebreaker in `orderByClause` keeps the order total).
 */
export function parseRunsPagination(ctx: { url: URL }): { limit: number; offset: number } {
	const rawLimit = ctx.url.searchParams.get("limit");
	const rawOffset = ctx.url.searchParams.get("offset");
	let limit = 100;
	if (rawLimit !== null) {
		const n = Number.parseInt(rawLimit, 10);
		if (!Number.isFinite(n) || n <= 0 || String(n) !== rawLimit) {
			throw new ValidationError(`?limit must be a positive integer; got '${rawLimit}'`);
		}
		if (n > 500) throw new ValidationError("?limit must be ≤ 500");
		limit = n;
	}
	let offset = 0;
	if (rawOffset !== null) {
		const n = Number.parseInt(rawOffset, 10);
		if (!Number.isFinite(n) || n < 0 || String(n) !== rawOffset) {
			throw new ValidationError(`?offset must be a non-negative integer; got '${rawOffset}'`);
		}
		offset = n;
	}
	return { limit, offset };
}

async function projectRunsWithFacts(
	deps: ServerDeps,
	runs: readonly RunRow[],
	actor: Actor | undefined,
): Promise<unknown[]> {
	const publicOnly = isPublicOnly(actor);
	const facts = publicOnly
		? new Map<string, DispatchFacts>()
		: await deps.repos.dispatchContext.getDispatchFactsByRunIds(runs.map((r) => r.id));
	return runs.map((run) => {
		const projected = projectRun(run, actor);
		if (publicOnly) return projected;
		const fact = facts.get(run.id);
		return {
			...projected,
			runtimeBackend: fact?.runtimeBackend ?? null,
		};
	});
}

export function listRunsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const project = ctx.url.searchParams.get("project");
		const agent = ctx.url.searchParams.get("agent");
		if (project !== null && agent !== null) {
			throw new ValidationError("filter by either ?project=... or ?agent=..., not both");
		}
		const order = parseRunsSort(ctx);
		const page = parseRunsPagination(ctx);
		const listOpts = { ...order, ...page };
		const rows =
			project !== null
				? await deps.repos.runs.listByProject(project, listOpts)
				: agent !== null
					? await deps.repos.runs.listByAgent(agent, listOpts)
					: await deps.repos.runs.listAll(listOpts);

		// bridge died before the final checkpoint landed.
		const hydrated = await hydrateRunsUsage(rows, deps.repos.events, deps.repos.runs);
		// warren-ee50 / pl-b0c0 step 1: aggregate the full filtered set so
		// the Runs page can show all-time totals next to a paginated table.
		const aggFilter = {
			...(project !== null ? { projectId: project } : {}),
			...(agent !== null ? { agentName: agent } : {}),
		};
		const agg = await deps.repos.runs.aggregate(aggFilter);

		const projectedRuns = await projectRunsWithFacts(deps, hydrated, ctx.actor);
		return jsonResponse(200, {
			runs: projectedRuns,
			total: agg.total,
			limit: page.limit,
			offset: page.offset,
		});
	};
}

export function getRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const row = await deps.repos.runs.require(id);
		// warren-ab18: same compute-on-read fallback as the list handler

		const run = await hydrateRunUsage(row, deps.repos.events);
		// warren-7d84: detail GETs wrap the resource, matching POST /runs
		// ({run}) and the plan-runs family ({planRun, children, runs}) so
		// consumers need no per-route envelope knowledge.
		return jsonResponse(200, { run: projectRun(run, ctx.actor) });
	};
}

export function parseAnalyticsDateBound(ctx: { url: URL }, name: string): string | undefined {
	const raw = ctx.url.searchParams.get(name);
	if (raw === null || raw === "") return undefined;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		throw new ValidationError(`?${name} must be an ISO8601 date or datetime`);
	}
	return d.toISOString();
}

/** Default analytics window when the caller supplies no `from` (days). */
export const ANALYTICS_DEFAULT_WINDOW_DAYS = 30;
/** Hard ceiling on the from..to span so an anonymous caller can't widen the scan (warren-30cc). */
export const ANALYTICS_MAX_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveAnalyticsWindow(
	from: string | undefined,
	to: string | undefined,
	nowMs: number = Date.now(),
): { from: string; to: string } {
	const toMs = to !== undefined ? Date.parse(to) : nowMs;
	let fromMs =
		from !== undefined ? Date.parse(from) : toMs - ANALYTICS_DEFAULT_WINDOW_DAYS * DAY_MS;
	if (toMs - fromMs > ANALYTICS_MAX_WINDOW_DAYS * DAY_MS) {
		fromMs = toMs - ANALYTICS_MAX_WINDOW_DAYS * DAY_MS;
	}
	return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

export function extractProviderModel(rendered: unknown): { provider?: string; model?: string } {
	if (rendered === null || typeof rendered !== "object") return {};
	const fm = (rendered as { frontmatter?: unknown }).frontmatter;
	if (fm === null || fm === undefined || typeof fm !== "object") return {};
	return readProviderFrontmatter(fm as Readonly<Record<string, unknown>>);
}
