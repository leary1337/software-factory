/**
 * The canonical HTTP route table (`ROUTE_TABLE`) and everything derived
 * from it: the route builder, the API path prefixes, the auth-exemption
 * predicate, and the policy projections consumed by tests and the docs
 * generators (split out of `./index.ts`, warren-a647/c9ac).
 * `scripts/generate-docs.ts` and `scripts/generate-openapi.ts` parse
 * `ROUTE_TABLE` out of THIS file textually.
 */

import type { Route, RouteHandler, RoutePolicy, ServerDeps } from "../types.ts";
import { getAgentHandler, listAgentsHandler } from "./agents.ts";
import { healAlertHandler } from "./alerts.ts";
import { readyzHandler } from "./diagnostics.ts";
import { listEventsHandler } from "./events-query.ts";
import { streamLifecycleEventsHandler } from "./events-stream.ts";
import { forgeReposHandler } from "./forge-repos.ts";
import {
	GITHUB_APP_ROUTE_PREFIX,
	gitHubAppCallbackHandler,
	gitHubAppInstalledHandler,
	gitHubAppRegistrationGatedHandler,
	gitHubAppRouteOptions,
	registerGitHubAppHandler,
} from "./github-app.ts";
import { instanceFactsHandler } from "./instance.ts";
import { judgeVerdictsProxyHandler } from "./judge-proxy.ts";
import { healthzHandler, previewConfigHandler, versionHandler, whoamiHandler } from "./meta.ts";
import { metricsHandler } from "./metrics.ts";
import { opsOverviewHandler } from "./ops-overview.ts";
import {
	cancelPlanRunHandler,
	createPlanRunHandler,
	getPlanRunHandler,
	listPlanRunsHandler,
	resumePlanRunHandler,
	streamPlanRunEventsHandler,
} from "./plan-runs.ts";
import { retryPlanRunReviewHandler } from "./plan-runs-retry-review.ts";
import { getProjectDeployHandler, startProjectDeployHandler } from "./projects.deploy.ts";
import { configMigrateProjectHandler, initProjectHandler } from "./projects.init.ts";
import {
	createProjectHandler,
	deleteProjectHandler,
	getProjectHandler,
	getProjectSeedHandler,
	getProjectTriggersHandler,
	listProjectSeedPlansHandler,
	listProjectsHandler,
	listReadyPlansHandler,
	refreshProjectHandler,
	runProjectTriggerHandler,
} from "./projects.ts";
import { getProjectWarrenConfigHandler } from "./projects.warren-config.ts";
import {
	cancelRunHandler,
	createRunHandler,
	getRunFinalizeIntentHandler,
	getRunHandler,
	listBehaviorAnalyticsHandler,
	listDispatchAnalyticsHandler,
	listRunAnalyticsHandler,
	listRunsHandler,
	pollRunInboxHandler,
	postRunFinalizeResultHandler,
	postRunGitCredentialHandler,
	postRunSalvageHandler,
	previewLoginHandler,
	previewTeardownHandler,
	steerRunHandler,
	streamRunEventsHandler,
} from "./runs/index.ts";
import { setupHandoffHandler } from "./setup.ts";

/* ----------------------------------------------------------------------- */
/* Route table                                                              */
/* ----------------------------------------------------------------------- */

interface RouteEntry {
	readonly method: Route["method"];
	readonly pattern: string;
	/**
	 * The capability this route demands (warren-b875). Required — TypeScript
	 * refuses an entry that omits it, so a new route can never default to
	 * open. Enforced once, in `handleRequest` (`src/server/server.ts`).
	 */
	readonly policy: RoutePolicy;
	readonly build: (deps: ServerDeps) => RouteHandler;
}

const ROUTE_TABLE: readonly RouteEntry[] = [
	{ method: "GET", pattern: "/healthz", policy: "anonymous", build: () => healthzHandler() },
	{ method: "GET", pattern: "/readyz", policy: "readOperator", build: readyzHandler },
	{ method: "GET", pattern: "/version", policy: "anonymous", build: () => versionHandler() },
	// warren-a647: App manifest registration; anonymous — see ./github-app.ts.
	{
		method: "GET",
		pattern: "/github-app/register",
		policy: "anonymous",
		build: () => registerGitHubAppHandler(),
	},
	{
		method: "GET",
		pattern: "/github-app/callback",
		policy: "anonymous",
		build: (deps) => gitHubAppCallbackHandler(gitHubAppRouteOptions(deps)),
	},
	// warren-54c7: the manifest setup_url target — GitHub's post-install redirect.
	{
		method: "GET",
		pattern: "/github-app/installed",
		policy: "anonymous",
		build: (deps) => gitHubAppInstalledHandler(gitHubAppRouteOptions(deps)),
	},
	// warren-48f8: setup-code redemption; anonymous by necessity — the code IS
	// the auth. 404 unless the boot armed the handoff (src/server/setup-handoff.ts).
	{
		method: "GET",
		pattern: "/setup",
		policy: "anonymous",
		build: (deps) => setupHandoffHandler(deps.setupHandoff),
	},
	// warren-1b40: operator-gated reverse proxy to the judge extension's
	// /verdicts.jsonl export. Server-held base URL + export token from env
	// (see ./judge-proxy.ts); never the SPA fallback.
	{
		method: "GET",
		pattern: "/extensions/judge/verdicts.jsonl",
		policy: "readOperator",
		build: () => judgeVerdictsProxyHandler(),
	},
	{ method: "GET", pattern: "/metrics", policy: "readOperator", build: metricsHandler },
	// pl-7e38 step 12 (warren-d850): one-poll Operations snapshot, readPublic with a reduced projection.
	{ method: "GET", pattern: "/ops/overview", policy: "readPublic", build: opsOverviewHandler },
	// pl-7e38 step 15 (warren-5eec): cross-run Event explorer query, same per-row `projectEvent` reduction.
	{ method: "GET", pattern: "/events", policy: "readPublic", build: listEventsHandler },
	// warren-e195: `readPublic`, not `anonymous` — an exempt route gets no actor to name.
	{ method: "GET", pattern: "/whoami", policy: "readPublic", build: () => whoamiHandler() },
	// warren-2eec: read-only instance facts; spectators get the reduced projection (src/instance/facts.ts).
	{ method: "GET", pattern: "/instance", policy: "readPublic", build: instanceFactsHandler },
	// warren-2601: installation repo listing for the Add Project picker (readOperator — private repo names).
	{ method: "GET", pattern: "/forge/repos", policy: "readOperator", build: forgeReposHandler },
	{ method: "GET", pattern: "/agents", policy: "readPublic", build: listAgentsHandler },
	{ method: "GET", pattern: "/agents/:name", policy: "readPublic", build: getAgentHandler },
	// warren-3db0: closed-loop alert intake. Token-gated via the standard
	// bearer gate (not auth-exempt); webhook senders carry the bearer.
	{ method: "POST", pattern: "/alerts/heal", policy: "dispatch", build: healAlertHandler },
	{ method: "GET", pattern: "/projects", policy: "readPublic", build: listProjectsHandler },
	{ method: "POST", pattern: "/projects", policy: "admin", build: createProjectHandler },
	{ method: "GET", pattern: "/projects/:id", policy: "readPublic", build: getProjectHandler },
	{
		method: "GET",
		pattern: "/projects/:id/warren-config",
		policy: "readPublic",
		build: getProjectWarrenConfigHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/triggers",
		policy: "readOperator",
		build: getProjectTriggersHandler,
	},
	// Static path — must precede the :seedId param route so "plans" isn't swallowed as a seed id.
	{
		method: "GET",
		pattern: "/projects/:id/seeds/plans",
		policy: "readOperator",
		build: listProjectSeedPlansHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/deploy",
		policy: "readOperator",
		build: getProjectDeployHandler,
	},
	{
		method: "POST",
		pattern: "/projects/:id/deploy",
		policy: "dispatch",
		build: startProjectDeployHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/ready-plans",
		policy: "readPublic",
		build: listReadyPlansHandler,
	},
	{
		method: "GET",
		pattern: "/projects/:id/seeds/:seedId",
		policy: "readOperator",
		build: getProjectSeedHandler,
	},
	{
		method: "POST",
		pattern: "/projects/:id/triggers/:triggerId/run",
		policy: "dispatch",
		build: runProjectTriggerHandler,
	},
	{
		method: "POST",
		pattern: "/projects/:id/refresh",
		policy: "admin",
		build: refreshProjectHandler,
	},
	// warren-166d: server-side `.warren/` writes into the host clone, so a remote CLI can scaffold
	// or migrate a project it cannot see on disk. `admin` matches refresh — an operator-gated mutation.
	{ method: "POST", pattern: "/projects/:id/init", policy: "admin", build: initProjectHandler },
	{
		method: "POST",
		pattern: "/projects/:id/config-migrate",
		policy: "admin",
		build: configMigrateProjectHandler,
	},
	{ method: "DELETE", pattern: "/projects/:id", policy: "admin", build: deleteProjectHandler },

	// aggregates stay redacted, including the per-agent/per-model/per-provider buckets, because

	{
		method: "GET",
		pattern: "/analytics/runs",
		policy: "readPublic",
		build: listRunAnalyticsHandler,
	},
	{
		method: "GET",
		pattern: "/analytics/behavior",
		policy: "readOperator",
		build: listBehaviorAnalyticsHandler,
	},
	{
		method: "GET",
		pattern: "/analytics/dispatch",
		policy: "readOperator",
		build: listDispatchAnalyticsHandler,
	},
	{ method: "GET", pattern: "/runs", policy: "readPublic", build: listRunsHandler },
	// warren-f566: the global lifecycle notification stream (NDJSON, one
	// `{runId, hook, state, ts}` line per lifecycle transition). The list
	// pages hold ONE connection per tab and debounce-invalidate their list
	// queries instead of polling /runs every 5s. `?follow=0` is a probe
	// shorthand (immediate clean close, empty body). Operator-gated — a
	// public spectator never gets a held-open feed of every run id on the
	// instance (scenario 39); it stays on the fallback poll.
	{
		method: "GET",
		pattern: "/events/stream",
		policy: "readOperator",
		build: streamLifecycleEventsHandler,
	},
	{ method: "POST", pattern: "/runs", policy: "dispatch", build: createRunHandler },
	{ method: "GET", pattern: "/runs/:id", policy: "readPublic", build: getRunHandler },
	// NDJSON event tail. `?follow=1` live-tails (the default while the run
	// is non-terminal); `?limit=N` requests a bounded non-streaming read of
	// at most N events and implies follow=false — the response closes after
	// the page, so agents can poll for liveness without holding a stream
	// open (warren-17c1). `?since=<seq>` pages forward from a prior read.
	{
		method: "GET",
		pattern: "/runs/:id/events",
		policy: "readPublic",
		build: streamRunEventsHandler,
	},
	// warren-3d0b: the in-pod steering poll for the K8s backend. Bearer-gated
	// like every /runs route; the pod carries its per-run SCOPED token
	// (warren-57fd). Destructive on read (it claims unread messages), so for a
	// non-run caller it is operator-only (warren-b875). `?peek=1` lists the
	// unread queue WITHOUT claiming (warren-3305) — the only safe way for an
	// operator or the UI to inspect it; a bare poll steals the message from
	// the pod's steering poll.
	{ method: "GET", pattern: "/runs/:id/inbox", policy: "readOperator", build: pollRunInboxHandler },
	// warren-0d35: the in-pod finalize callback for the K8s backend — the pod
	// fetches the reap intent, runs the workspace-dependent half in place, and
	// POSTs the FinalizeResult back. Bearer-gated; the pod carries its per-run
	// scoped token (warren-57fd).
	{
		method: "GET",
		pattern: "/runs/:id/finalize-intent",
		policy: "readOperator",
		build: getRunFinalizeIntentHandler,
	},
	{
		method: "POST",
		pattern: "/runs/:id/finalize-result",
		policy: "dispatch",
		build: postRunFinalizeResultHandler,
	},
	// warren-cd3b: the in-pod salvage intake — the pod POSTs the work it
	// captured (rescue ref + git bundle) when the finalize branch push failed
	// or no reap intent ever arrived, BEFORE its emptyDir dies with the pod.
	{
		method: "POST",
		pattern: "/runs/:id/salvage",
		policy: "dispatch",
		build: postRunSalvageHandler,
	},
	// warren-c9ac: the in-pod credential re-mint (forge-contract.md §4.1 window
	// 3) — the pod requests a freshly-minted push credential over the same
	// authenticated callback channel instead of trusting the mounted Secret.
	{
		method: "POST",
		pattern: "/runs/:id/git-credential",
		policy: "dispatch",
		build: postRunGitCredentialHandler,
	},
	{ method: "POST", pattern: "/runs/:id/steer", policy: "dispatch", build: steerRunHandler },
	{ method: "POST", pattern: "/runs/:id/cancel", policy: "dispatch", build: cancelRunHandler },
	// warren-e1b0: POST, not GET — the bearer rides the `Authorization`
	// header like every other /runs route instead of a `?token=` query
	// string that would land in history / Referer / proxy logs.
	{
		method: "POST",
		pattern: "/runs/:id/preview/login",
		policy: "dispatch",
		build: previewLoginHandler,
	},
	{
		method: "POST",
		pattern: "/runs/:id/preview/teardown",
		policy: "dispatch",
		build: previewTeardownHandler,
	},
	{
		method: "GET",
		pattern: "/preview/config",
		policy: "readOperator",
		build: previewConfigHandler,
	},
	{ method: "GET", pattern: "/plan-runs", policy: "readPublic", build: listPlanRunsHandler },
	{ method: "POST", pattern: "/plan-runs", policy: "dispatch", build: createPlanRunHandler },
	{ method: "GET", pattern: "/plan-runs/:id", policy: "readPublic", build: getPlanRunHandler },
	{
		method: "POST",
		pattern: "/plan-runs/:id/children/:seq/retry-review",
		policy: "dispatch",
		build: retryPlanRunReviewHandler,
	},
	{
		method: "POST",
		pattern: "/plan-runs/:id/cancel",
		policy: "dispatch",
		build: cancelPlanRunHandler,
	},
	{
		method: "POST",
		pattern: "/plan-runs/:id/resume",
		policy: "dispatch",
		build: resumePlanRunHandler,
	},
	{
		method: "GET",
		pattern: "/plan-runs/:id/events",
		policy: "readPublic",
		build: streamPlanRunEventsHandler,
	},
];

export function buildApiRoutes(deps: ServerDeps): Route[] {
	// Absent gate ⇒ legacy/test wiring keeps the historical always-on
	// behavior; production boot (`bootServer`) always resolves the gate.
	const gate = deps.gitHubAppRegistration;
	const gitHubAppGatedOff = gate !== undefined && !gate.enabled;
	return ROUTE_TABLE.map((entry) => ({
		method: entry.method,
		pattern: entry.pattern,
		policy: entry.policy,
		handler:
			gitHubAppGatedOff && entry.pattern.startsWith(GITHUB_APP_ROUTE_PREFIX)
				? (ctx) => gitHubAppRegistrationGatedHandler(ctx.url.pathname)
				: entry.build(deps),
	}));
}

/**
 * Top-level prefixes the API claims. Any pathname under one of these is
 * an API request: it requires auth (except `/healthz`, see
 * `isAuthExempt`) and the SPA fallback in `ui.ts` refuses to serve
 * `index.html` for it. Kept in sync with `ROUTE_TABLE` by hand — the
 * router patterns are richer than prefixes (`/agents/:name`,
 * `/runs/:id/events`) so we can't derive these without either parsing
 * the patterns or duplicating the policy.
 */
export const API_PREFIXES: readonly string[] = [
	"/agents",
	"/alerts",
	"/analytics",
	"/projects",
	"/runs",
	"/healthz",
	"/readyz",
	"/version",
	"/metrics",
	"/ops",
	"/preview",
	"/plan-runs",
	"/whoami",
	// warren-2eec: instance facts surface (`GET /instance`).
	"/instance",
	"/github-app",
	"/setup", // warren-48f8: the setup-handoff redemption page (an API path, not SPA).
	"/events",
	"/extensions", // warren-1b40: the judge export proxy surface.
	"/forge", // warren-2601: installation repo listing for the Add Project picker.
];

/**
 * True iff `pathname` is one of the API surfaces above. Cheap prefix
 * scan — a handful of entries, no allocations on the hot path.
 */
export function isApiPath(pathname: string): boolean {
	for (const prefix of API_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true;
	}
	return false;
}

/**
 * API paths the auth gate skips entirely — derived from the routes whose
 * declared policy is `anonymous` (warren-b875), so the exemption list is the
 * policy table rather than a second hand-maintained copy of it. Only static
 * patterns can appear here; a `:param` pattern would never match a real
 * pathname by string equality (asserted in `index.test.ts`).
 */
const AUTH_EXEMPT_PATHS: ReadonlySet<string> = new Set(
	ROUTE_TABLE.filter((e) => e.policy === "anonymous").map((e) => e.pattern),
);

/**
 * Anonymous routes and non-API paths (SPA assets/deep links) need no bearer.
 * Every other API route requires authentication and its declared capability.
 * Metrics and readiness expose operator diagnostics and remain gated; preview
 * login uses an Authorization header rather than a token in its URL.
 */
export function isAuthExempt(pathname: string): boolean {
	if (AUTH_EXEMPT_PATHS.has(pathname)) return true;
	return !isApiPath(pathname);
}

/**
 * The declared policy of every API route (warren-b875) — the readable form
 * of `ROUTE_TABLE` for tests and tooling that must not build handlers.
 */
export const API_ROUTE_POLICIES: readonly {
	method: Route["method"];
	pattern: string;
	policy: RoutePolicy;
}[] = ROUTE_TABLE.map((e) => ({ method: e.method, pattern: e.pattern, policy: e.policy }));

export const API_ROUTE_PATTERNS: readonly { method: Route["method"]; pattern: string }[] =
	API_ROUTE_POLICIES;
