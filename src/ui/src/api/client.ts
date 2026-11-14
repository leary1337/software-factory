// Browser HTTP client. Authentication follows the same-origin server session.

import { readNdjsonStream } from "../../../client/ndjson.ts";
import type { ProjectDeployResponse } from "./deploy-types.ts";
import type { InstanceFactsResponse } from "./instance-types.ts";
import type { OpsOverviewResponse } from "./ops-types.ts";
import type {
	RunAnalyticsFilter,
	RunAnalyticsResponse,
	RunBehaviorResponse,
} from "./run-analytics-types.ts";
import type {
	AgentRow,
	ApiErrorEnvelope,
	CancelPlanRunResponse,
	CancelRunResponse,
	CreatePlanRunInput,
	CreatePlanRunResponse,
	CreateRunInput,
	EventStream,
	LifecycleStreamNotification,
	ListRunsResponse,
	PlanRunDetailResponse,
	PlanRunRow,
	PlanRunStateFilter,
	PreviewConfigResponse,
	PreviewLoginResponse,
	PreviewTeardownResponse,
	ProjectRow,
	ReadyPlansResponse,
	ReadyzResponse,
	RefreshProjectResponse,
	RunEvent,
	RunRow,
	RunTriggerResponse,
	SeedPlansResponse,
	SeedStatusResponse,
	SpawnRunResponse,
	SteerRunResponse,
	TriggersResponse,
	WarrenConfigResponse,
	WhoamiResponse,
} from "./types.ts";

export type {
	DimensionTokenSeries,
	RunAnalyticsTokensSection,
	TokenBreakdown,
	TokenDayBucket,
} from "./types.ts";

const TOKEN_KEY = "warren.apiToken";

export class UnauthorizedError extends Error {
	constructor(message = "unauthorized") {
		super(message);
		this.name = "UnauthorizedError";
	}
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly hint: string | undefined;
	constructor(status: number, envelope: ApiErrorEnvelope["error"]) {
		super(envelope.message);
		this.name = "ApiError";
		this.status = status;
		this.code = envelope.code;
		this.hint = envelope.hint;
	}
}

export function getApiToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setApiToken(token: string | null): void {
	try {
		if (token === null) localStorage.removeItem(TOKEN_KEY);
		else localStorage.setItem(TOKEN_KEY, token);
	} catch {
		// localStorage may be unavailable (private mode) — token only
		// lives for the session in that case.
	}
}

function clearRejectedToken(sent: string | null): void {
	if (sent !== null && getApiToken() === sent) setApiToken(null);
}

interface RequestOptions {
	method?: string;
	body?: unknown;
	signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = {
		accept: "application/json",
	};
	if (opts.body !== undefined) headers["content-type"] = "application/json";
	const token = getApiToken();
	if (token !== null && token.length > 0) headers.authorization = `Bearer ${token}`;

	const init: RequestInit = { method: opts.method ?? "GET", headers };
	if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
	if (opts.signal !== undefined) init.signal = opts.signal;

	const res = await fetch(path, init);
	if (res.status === 401) {
		clearRejectedToken(token);
		throw new UnauthorizedError("API token rejected; please re-authenticate");
	}
	const text = await res.text();
	if (!res.ok) {
		let envelope: ApiErrorEnvelope | null = null;
		try {
			envelope = text.length > 0 ? (JSON.parse(text) as ApiErrorEnvelope) : null;
		} catch {
			envelope = null;
		}
		const err = envelope?.error ?? {
			code: `http_${res.status}`,
			message: text || res.statusText,
		};
		throw new ApiError(res.status, err);
	}
	if (text.length === 0) return undefined as T;
	return JSON.parse(text) as T;
}

/* ----------------------------------------------------------------------- */
/* Agents                                                                   */
/* ----------------------------------------------------------------------- */

export interface AgentsFilter {
	projectId?: string;
}

function agentsQuery(filter: AgentsFilter): string {
	if (filter.projectId === undefined || filter.projectId.length === 0) return "";
	const params = new URLSearchParams({ projectId: filter.projectId });
	return `?${params.toString()}`;
}

export const agentsApi = {
	list: (filter: AgentsFilter = {}, signal?: AbortSignal) =>
		request<{ agents: AgentRow[] }>(`/agents${agentsQuery(filter)}`, {
			...(signal ? { signal } : {}),
		}),
	get: (name: string, filter: AgentsFilter = {}, signal?: AbortSignal) =>
		request<AgentRow>(`/agents/${encodeURIComponent(name)}${agentsQuery(filter)}`, {
			...(signal ? { signal } : {}),
		}),
};

/* ----------------------------------------------------------------------- */
/* Projects                                                                 */
/* ----------------------------------------------------------------------- */

export const projectsApi = {
	settings: (id: string, signal?: AbortSignal) =>
		request<import("../../../core/project-settings.ts").ProjectSettingsResponse>(
			`/projects/${encodeURIComponent(id)}/settings`,
			{ ...(signal ? { signal } : {}) },
		),
	updateSettings: (
		id: string,
		input: import("../../../core/project-settings.ts").ProjectSettingsUpdate,
	) =>
		request<import("../../../core/project-settings.ts").ProjectSettingsResponse>(
			`/projects/${encodeURIComponent(id)}/settings`,
			{ method: "PATCH", body: input },
		),
	list: (signal?: AbortSignal) =>
		request<{ projects: ProjectRow[] }>("/projects", { ...(signal ? { signal } : {}) }),
	get: (id: string, signal?: AbortSignal) =>
		request<ProjectRow>(`/projects/${encodeURIComponent(id)}`, {
			...(signal ? { signal } : {}),
		}),
	create: (input: { gitUrl: string; defaultBranch?: string }) =>
		request<ProjectRow>("/projects", { method: "POST", body: input }),
	delete: (id: string) =>
		request<ProjectRow>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
	refresh: (id: string, input: { ref?: string } = {}) =>
		request<RefreshProjectResponse>(`/projects/${encodeURIComponent(id)}/refresh`, {
			method: "POST",
			body: input,
		}),
	warrenConfig: (id: string, signal?: AbortSignal) =>
		request<WarrenConfigResponse>(`/projects/${encodeURIComponent(id)}/warren-config`, {
			...(signal ? { signal } : {}),
		}),
	triggers: (id: string, signal?: AbortSignal) =>
		request<TriggersResponse>(`/projects/${encodeURIComponent(id)}/triggers`, {
			...(signal ? { signal } : {}),
		}),
	runTrigger: (id: string, triggerId: string) =>
		request<RunTriggerResponse>(
			`/projects/${encodeURIComponent(id)}/triggers/${encodeURIComponent(triggerId)}/run`,
			{ method: "POST", body: {} },
		),
	seedStatus: (id: string, seedId: string, signal?: AbortSignal) =>
		request<SeedStatusResponse>(
			`/projects/${encodeURIComponent(id)}/seeds/${encodeURIComponent(seedId)}`,
			{ ...(signal ? { signal } : {}) },
		),
	seedPlans: (id: string, signal?: AbortSignal) =>
		request<SeedPlansResponse>(`/projects/${encodeURIComponent(id)}/seeds/plans`, {
			...(signal ? { signal } : {}),
		}),

	deployOverview: (id: string, signal?: AbortSignal) =>
		request<ProjectDeployResponse>(`/projects/${encodeURIComponent(id)}/deploy`, {
			...(signal ? { signal } : {}),
		}),
	startDeploy: (id: string) =>
		request<{ dispatched: boolean; branch: string }>(`/projects/${encodeURIComponent(id)}/deploy`, {
			method: "POST",
			body: {},
		}),
	readyPlans: (id: string, signal?: AbortSignal) =>
		request<ReadyPlansResponse>(`/projects/${encodeURIComponent(id)}/ready-plans`, {
			...(signal ? { signal } : {}),
		}),
};

/* ----------------------------------------------------------------------- */
/* Event explorer (`GET /events`, pl-7e38 step 15 / warren-5eec)          */
/* ----------------------------------------------------------------------- */

export interface EventExplorerRow {
	id: number;
	runId: string;
	seq: number;
	ts: string;
	kind: string;
	stream: string | null;
	origin: string | null;
	payload: unknown;
}

export interface EventsListResponse {
	events: EventExplorerRow[];
	total: number;
	limit: number;
	offset: number;
}

export interface EventsQueryFilterUI {
	runId?: string;
	projectId?: string;
	kind?: string;
	/** One of the canonical `EVENT_STREAMS` (server-validated). */
	stream?: EventStream;
	/** Inclusive lower bound on `ts` (ISO8601). */
	since?: string;
	/** Inclusive upper bound on `ts` (ISO8601). */
	until?: string;
	limit?: number;
	offset?: number;
}

export const eventsApi = {
	list: (filter: EventsQueryFilterUI = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.runId) params.set("run", filter.runId);
		if (filter.projectId) params.set("project", filter.projectId);
		if (filter.kind) params.set("kind", filter.kind);
		if (filter.stream) params.set("stream", filter.stream);
		if (filter.since) params.set("since", filter.since);
		if (filter.until) params.set("until", filter.until);
		if (filter.limit !== undefined) params.set("limit", String(filter.limit));
		if (filter.offset !== undefined) params.set("offset", String(filter.offset));
		const qs = params.toString();
		return request<EventsListResponse>(`/events${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
};

/* ----------------------------------------------------------------------- */
/* Runs                                                                     */
/* ----------------------------------------------------------------------- */

export interface ListRunsFilter {
	project?: string;
	agent?: string;
	sort?: "started";
	dir?: "asc" | "desc";
	limit?: number;
	offset?: number;
}

export const runsApi = {
	list: (filter: ListRunsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.project) params.set("project", filter.project);
		if (filter.agent) params.set("agent", filter.agent);
		if (filter.sort) params.set("sort", filter.sort);
		if (filter.dir) params.set("dir", filter.dir);
		if (filter.limit !== undefined) params.set("limit", String(filter.limit));
		if (filter.offset !== undefined) params.set("offset", String(filter.offset));
		const qs = params.toString();
		return request<ListRunsResponse>(`/runs${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	// warren-7d84: `GET /runs/:id` wraps the row in `{run}` like every
	// other detail envelope; the UI client unwraps it for callers.
	get: async (id: string, signal?: AbortSignal) =>
		(
			await request<{ run: RunRow }>(`/runs/${encodeURIComponent(id)}`, {
				...(signal ? { signal } : {}),
			})
		).run,
	create: (input: CreateRunInput) =>
		request<SpawnRunResponse>("/runs", { method: "POST", body: input }),
	steer: (id: string, input: { body: string }) =>
		request<SteerRunResponse>(`/runs/${encodeURIComponent(id)}/steer`, {
			method: "POST",
			body: input,
		}),
	cancel: (id: string, input: { reason?: string } = {}) =>
		request<CancelRunResponse>(`/runs/${encodeURIComponent(id)}/cancel`, {
			method: "POST",
			body: input,
		}),
	previewTeardown: (id: string, input: { actor?: string } = {}) =>
		request<PreviewTeardownResponse>(`/runs/${encodeURIComponent(id)}/preview/teardown`, {
			method: "POST",
			body: input,
		}),
	/**
	 * Preview login handshake (`POST /runs/:id/preview/login`, R-19 /
	 * docs/design/preview-environments.md, warren-8a10 / warren-edff; warren-e1b0 moved the bearer
	 * out of the URL). The bearer rides the `Authorization` header like
	 * every other call in this module; the server answers with a
	 * `Set-Cookie` the browser stores for the same-origin preview surface
	 * plus the `url` to navigate to. The server picks the target from the
	 * deployment's `WARREN_PREVIEW_MODE` — `https://run-<id>.<host>/` in
	 * subdomain mode, `<origin>/p/<id>/` in path mode — so callers stay
	 * mode-agnostic.
	 */
	previewLogin: (id: string, input: { redirect?: string } = {}) =>
		request<PreviewLoginResponse>(`/runs/${encodeURIComponent(id)}/preview/login`, {
			method: "POST",
			body: input,
		}),
};

/**
 * Deployment-wide preview config (R-19 / docs/design/preview-environments.md path addendum,
 * warren-016d). Fetched once per session — mode/host can only change via
 * a warren restart — and consumed by `PreviewCard` to render the
 * canonical preview URL string.
 */
export const previewApi = {
	config: (signal?: AbortSignal) =>
		request<PreviewConfigResponse>("/preview/config", { ...(signal ? { signal } : {}) }),
};

/**
 * Format the canonical preview URL for a run. Mirrors server-side
 * `formatPreviewUrl` (`src/preview/launch/index.ts`) so the displayed URL
 * matches where the login handshake actually redirects:
 *
 *   - path mode      → `<preview-origin>/p/<runId>/`: `config.host` (or the
 *                       current `window.location.origin`) with `config.port`
 *                       swapped in — the dedicated preview listener's own
 *                       origin (warren-3f8a).
 *   - subdomain mode → `https://run-<runId>.<host>/` (host always set in
 *                       this mode; boot rejects subdomain without host).
 */
export function formatPreviewUrl(
	runId: string,
	config: PreviewConfigResponse,
	origin: string,
): string {
	if (config.mode === "path") {
		const base = new URL(config.host !== null ? `https://${config.host}` : origin);
		if (config.port !== null) base.port = String(config.port);
		return `${base.origin}/p/${encodeURIComponent(runId)}/`;
	}
	const host = config.host ?? "";
	return `https://run-${encodeURIComponent(runId)}.${host}/`;
}

/* ----------------------------------------------------------------------- */
/* Plan-runs (warren-f923 / warren-a87f, pl-a258).                          */
/* ----------------------------------------------------------------------- */

export interface ListPlanRunsFilter {
	project?: string;
	/** Omit for every state; `active` is the live view (warren-302a). */
	state?: PlanRunStateFilter;
}

export const planRunsApi = {
	list: (filter: ListPlanRunsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.project) params.set("project", filter.project);
		if (filter.state) params.set("state", filter.state);
		const qs = params.toString();
		return request<{ planRuns: PlanRunRow[] }>(`/plan-runs${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	get: (id: string, signal?: AbortSignal) =>
		request<PlanRunDetailResponse>(`/plan-runs/${encodeURIComponent(id)}`, {
			...(signal ? { signal } : {}),
		}),
	create: (input: CreatePlanRunInput) =>
		request<CreatePlanRunResponse>("/plan-runs", { method: "POST", body: input }),
	cancel: (id: string) =>
		request<CancelPlanRunResponse>(`/plan-runs/${encodeURIComponent(id)}/cancel`, {
			method: "POST",
			body: {},
		}),
	resume: (id: string) =>
		request<unknown>(`/plan-runs/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} }),
	retryReview: (id: string, seq: number) =>
		request<{ requested: boolean }>(
			`/plan-runs/${encodeURIComponent(id)}/children/${encodeURIComponent(seq)}/retry-review`,
			{ method: "POST", body: {} },
		),
	events: (id: string, opts: StreamRunEventsOptions = {}) => streamPlanRunEvents(id, opts),
};

export async function* streamPlanRunEvents(
	planRunId: string,
	opts: StreamRunEventsOptions = {},
): AsyncGenerator<RunEvent, void, void> {
	yield* streamNdjsonEvents(`/plan-runs/${encodeURIComponent(planRunId)}/events`, opts);
}

/* ----------------------------------------------------------------------- */
/* NDJSON event stream — `GET /runs/:id/events?follow=1` (docs/http-api.md).      */
/* ----------------------------------------------------------------------- */

export interface StreamRunEventsOptions {
	follow?: boolean;
	sinceSeq?: number;
	signal?: AbortSignal;
}

/**
 * Async iterator over NDJSON events. Each `yield` is one parsed
 * `RunEvent` from the wire. Caller's `signal` aborts the underlying
 * fetch so component unmount tears the connection down promptly.
 */
export async function* streamRunEvents(
	runId: string,
	opts: StreamRunEventsOptions = {},
): AsyncGenerator<RunEvent, void, void> {
	yield* streamNdjsonEvents(`/runs/${encodeURIComponent(runId)}/events`, opts);
}

/**
 * Async iterator over the global lifecycle notification stream
 * (`GET /events/stream`, warren-f566). One connection per tab feeds the
 * list pages' debounce-invalidation in place of their old 5s polls.
 * The server holds no replay — the reader invalidates its queries on
 * each line, so nothing is lost across a reconnect. Operator-gated: a
 * 403/401 surfaces as a permanent stop so the caller stays on its
 * fallback poll.
 */
export async function* streamLifecycleEvents(
	opts: StreamRunEventsOptions = {},
): AsyncGenerator<LifecycleStreamNotification, void, void> {
	yield* streamNdjsonEvents("/events/stream", { ...opts, follow: opts.follow ?? true });
}

/**
 * Shared NDJSON consumer for run + plan-run event streams. The server
 * uses the same `eventToNdjson` serializer for both, so the wire shape
 * matches and the only thing that varies is the URL prefix + `runId`
 * discriminator in each envelope.
 *
 * The line parser is the SDK's `readNdjsonStream` (warren-53a7) with the
 * UI's error factory injected, so this wrapper only owns URL/header
 * assembly and the 401 token-clearing side effect.
 */
async function* streamNdjsonEvents<T = RunEvent>(
	basePath: string,
	opts: StreamRunEventsOptions,
): AsyncGenerator<T, void, void> {
	const params = new URLSearchParams();
	if (opts.follow) params.set("follow", "1");
	if (opts.sinceSeq !== undefined) params.set("since", String(opts.sinceSeq));
	const qs = params.toString();
	const url = `${basePath}${qs.length > 0 ? `?${qs}` : ""}`;

	const headers: Record<string, string> = { accept: "application/x-ndjson" };
	const token = getApiToken();
	if (token !== null && token.length > 0) headers.authorization = `Bearer ${token}`;

	const init: RequestInit = { headers };
	if (opts.signal) init.signal = opts.signal;

	yield* readNdjsonStream<T>(() => fetch(url, init), {
		errorFactory: (res) => streamErrorFromResponse(res, token),
	});
}

/**
 * Map a non-OK NDJSON response to the UI's error vocabulary. A 401 clears
 * the cached token it was sent with so the router redirects back to login; anything else
 * becomes an {@link ApiError} carrying the server's error envelope.
 */
async function streamErrorFromResponse(res: Response, sent: string | null): Promise<Error> {
	if (res.status === 401) {
		clearRejectedToken(sent);
		return new UnauthorizedError("API token rejected; please re-authenticate");
	}
	const text = await res.text();
	let envelope: ApiErrorEnvelope | null = null;
	try {
		envelope = text.length > 0 ? (JSON.parse(text) as ApiErrorEnvelope) : null;
	} catch {
		envelope = null;
	}
	return new ApiError(
		res.status,
		envelope?.error ?? { code: `http_${res.status}`, message: text || res.statusText },
	);
}

/* ----------------------------------------------------------------------- */
/* ----------------------------------------------------------------------- */
/* Ops overview (pl-7e38 step 12 / warren-d850)                            */
/* ----------------------------------------------------------------------- */

/** One repository the App installation can see (warren-2601). */
export interface ForgeRepoRow {
	owner: string;
	name: string;
	cloneUrl: string;
	defaultBranch: string;
	private: boolean;
}

/** The `GET /forge/repos` envelope; `supported` is the picker's discriminant. */
export interface ForgeReposResponse {
	supported: boolean;
	repos: ForgeRepoRow[];
	/** Present when the listing failed — the forge's redacted detail. */
	error?: string;
}

export const forgeApi = {
	/**
	 * `GET /forge/repos` — the Add Project repo picker's data source
	 * (warren-2601). `supported: false` (PAT / no forge / listing failure)
	 * means the dialog keeps the URL-paste path only.
	 */
	repos: (signal?: AbortSignal) =>
		request<ForgeReposResponse>("/forge/repos", { ...(signal ? { signal } : {}) }),
};

/** Trailing window selection for the ops-overview snapshot (warren-7194). */
function opsOverviewQuery(window?: string): string {
	return window === undefined ? "" : `?window=${encodeURIComponent(window)}`;
}

export const opsApi = {
	/**
	 * One-poll control-plane snapshot behind the Operations page
	 * (pl-7e38 step 13). Spectators get the reduced projection — the
	 * envelope's operator sections arrive undefined, never zero.
	 */
	overview: (window?: string, signal?: AbortSignal) =>
		request<OpsOverviewResponse>(`/ops/overview${opsOverviewQuery(window)}`, {
			...(signal ? { signal } : {}),
		}),
};

/* Meta                                                                     */
/* ----------------------------------------------------------------------- */

export const instanceApi = {
	/**
	 * `GET /instance` — boot-resolved instance facts (warren-2eec). The
	 * body is an allowlist; spectators get the reduced projection. The
	 * Dispatch page reads the runtime kind and admission caps off it.
	 */
	facts: (signal?: AbortSignal) =>
		request<InstanceFactsResponse>("/instance", { ...(signal ? { signal } : {}) }),
};

export const metaApi = {
	healthz: () => request<{ ok: boolean }>("/healthz"),
	readyz: () => request<ReadyzResponse>("/readyz"),
	version: (signal?: AbortSignal) =>
		request<{ version: string }>("/version", { ...(signal ? { signal } : {}) }),
	/**
	 * Who warren admitted this browser as, and what it may do (warren-e195).
	 * The capability layer calls this on mount and renders operator-only
	 * affordances from the answer instead of inferring permission from the
	 * presence of a stored token. Gated: under the default
	 * `WARREN_AUTH=token` a browser with no token gets a 401, which
	 * `request` already turns into `UnauthorizedError`.
	 */
	whoami: (signal?: AbortSignal) =>
		request<WhoamiResponse>("/whoami", { ...(signal ? { signal } : {}) }),
	/**
	 * Boot-resolved instance facts (warren-2eec), for the Instance and
	 * Login pages. Read-only by construction; the body shrinks under the
	 * public spectator projection, and the pages placeholder the absent
	 * fields.
	 */
	instance: (signal?: AbortSignal) =>
		request<InstanceFactsResponse>("/instance", { ...(signal ? { signal } : {}) }),
};

/* ----------------------------------------------------------------------- */
/* Run + behavior analytics wire types live in ./run-analytics-types.ts    */
/* (file-size budget, warren-be04); re-exported so import sites are        */
/* unchanged. The sentinel constants ride along.                           */
/* ----------------------------------------------------------------------- */

export * from "./run-analytics-types.ts";

export const runAnalyticsApi = {
	runs: (filter: RunAnalyticsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.projectId) params.set("projectId", filter.projectId);
		if (filter.from) params.set("from", filter.from);
		if (filter.to) params.set("to", filter.to);
		const qs = params.toString();
		return request<RunAnalyticsResponse>(`/analytics/runs${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
	behavior: (filter: RunAnalyticsFilter = {}, signal?: AbortSignal) => {
		const params = new URLSearchParams();
		if (filter.projectId) params.set("projectId", filter.projectId);
		if (filter.from) params.set("from", filter.from);
		if (filter.to) params.set("to", filter.to);
		const qs = params.toString();
		return request<RunBehaviorResponse>(`/analytics/behavior${qs.length > 0 ? `?${qs}` : ""}`, {
			...(signal ? { signal } : {}),
		});
	},
};

export const toolkitApi = {
	status: (signal?: AbortSignal) =>
		request<import("../../../core/wire-toolkit.ts").ToolkitStatus>("/toolkit", { signal }),
	check: () =>
		request<import("../../../core/wire-toolkit.ts").ToolkitCheck>("/toolkit/check", {
			method: "POST",
			body: {},
		}),
	apply: (version: string) =>
		request<import("../../../core/wire-toolkit.ts").ToolkitStatus>("/toolkit/apply", {
			method: "POST",
			body: { version },
		}),
};

export const approvalsApi = {
	prepare: (input: import("../../../core/plan-approval.ts").PreparePlanApproval) =>
		request<{ approval: import("../../../core/plan-approval.ts").PlanApproval }>(
			"/plan-approvals",
			{ method: "POST", body: input },
		),
	get: (id: string, signal?: AbortSignal) =>
		request<{ approval: import("../../../core/plan-approval.ts").PlanApproval }>(
			`/plan-approvals/${encodeURIComponent(id)}`,
			{ signal },
		),
	start: (id: string) =>
		request<CreatePlanRunResponse>(`/plan-approvals/${encodeURIComponent(id)}/start`, {
			method: "POST",
			body: {},
		}),
	history: (id: string, signal?: AbortSignal) =>
		request<import("../../../core/plan-approval.ts").PlanApprovalHistory>(
			`/plan-runs/${encodeURIComponent(id)}/approval`,
			{ signal },
		),
	revise: (id: string, input: import("../../../core/plan-approval.ts").RevisePlanApproval) =>
		request<{ approval: import("../../../core/plan-approval.ts").PlanApproval }>(
			`/plan-runs/${encodeURIComponent(id)}/revisions`,
			{ method: "POST", body: input },
		),
};

export const readinessApi = {
	get: (id: string, signal?: AbortSignal) =>
		request<import("../../../core/readiness.ts").ProjectReadiness>(
			`/projects/${encodeURIComponent(id)}/readiness`,
			{ signal },
		),
	check: (id: string) =>
		request<import("../../../core/readiness.ts").ProjectReadiness>(
			`/projects/${encodeURIComponent(id)}/readiness/check`,
			{ method: "POST", body: {} },
		),
	setup: (id: string) =>
		request<import("../../../core/readiness.ts").ProjectSetupProposal>(
			`/projects/${encodeURIComponent(id)}/setup-pr`,
			{ method: "POST", body: {} },
		),
};

export const newProjectsApi = {
	preview: (input: import("../../../core/new-project.ts").NewProjectRequest) =>
		request<import("../../../core/new-project.ts").NewProjectPreview>("/projects/new/preview", {
			method: "POST",
			body: input,
		}),
	create: (input: {
		request: import("../../../core/new-project.ts").NewProjectRequest;
		confirmation: string;
	}) =>
		request<{ project: ProjectRow; created: boolean; ready: false }>("/projects/new", {
			method: "POST",
			body: input,
		}),
};
