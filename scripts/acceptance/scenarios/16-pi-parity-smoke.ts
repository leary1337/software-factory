import {
	AcceptanceError,
	assertEqual,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { waitForFirstEvent, waitForRunPredicate } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
}

interface AgentDefinitionEnvelope {
	readonly name: string;
	readonly version: number;
	readonly sections: Record<string, string>;
	readonly resolvedFrom?: readonly string[];
	readonly frontmatter?: Record<string, unknown>;
}

interface AgentRow {
	readonly name: string;
	readonly source?: string;
	readonly renderedJson: AgentDefinitionEnvelope;
}

interface RunRow {
	readonly id: string;
	readonly agentName: string;
	readonly projectId: string | null;
	readonly sandboxId: string | null;
	readonly sandboxRunId: string | null;
	readonly renderedAgentJson: AgentDefinitionEnvelope;
	readonly state: string;
	readonly prompt: string;
	readonly trigger: string;
	readonly tokensInput?: number | null;
	readonly tokensOutput?: number | null;
	readonly tokensCacheRead?: number | null;
	readonly tokensCacheWrite?: number | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
	readonly sandbox: { readonly id: string; readonly workspacePath: string };
}

const RUN_ID_PATTERN = /^run_[0-9a-hjkmnpqrstvwxyz]{12}$/;
const FIRST_EVENT_TIMEOUT_MS = 15_000;
const PI_USAGE_TIMEOUT_MS = 15_000;

export const scenario: Scenario = {
	id: "16",
	title:
		"pi built-in parity smoke — POST /runs agent=pi dispatches through the local engine and emits events",
	// Same constraint as scenario 04: needs the host-side sample project,
	// the canopy fixture, and the pi PATH shim. Container mode does not
	// bind-mount any of those.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// 1. GET /agents/pi — the boot-seed should have registered the
		// built-in before the harness even runs scenarios. The detail row
		// carries source='builtin' (via readAgentSource off frontmatter).
		const piAgent = await http.expectJson<AgentRow>("GET", "/agents/pi", 200);
		assertEqual(piAgent.name, "pi", "GET /agents/pi name");
		assertEqual(piAgent.source, "builtin", "GET /agents/pi source");
		assertEqual(piAgent.renderedJson.name, "pi", "GET /agents/pi renderedJson.name");
		assertTrue(
			(piAgent.renderedJson.sections.system?.length ?? 0) > 0,
			"GET /agents/pi renderedJson.sections.system is non-empty",
		);
		assertEqual(
			piAgent.renderedJson.frontmatter?.source,
			"builtin",
			"GET /agents/pi renderedJson.frontmatter.source",
		);

		const project = await ensureProject(http, ctx.fixtures.sampleProjectGitUrl);

		// 2. POST /runs with agent='pi' — 201 + run_xxx, the sandbox/run ids
		// populated by spawnRun (proves the engine accepted the dispatch).
		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: "pi",
				project: project.id,
				prompt: "scenario-16 pi parity smoke",
			},
		});
		const run = created.run;
		assertTrue(
			RUN_ID_PATTERN.test(run.id),
			`POST /runs run.id ${JSON.stringify(run.id)} does not match ${RUN_ID_PATTERN}`,
		);
		assertEqual(run.agentName, "pi", "POST /runs run.agentName");
		assertEqual(run.projectId, project.id, "POST /runs run.projectId");
		assertTrue(
			typeof run.sandboxId === "string" && run.sandboxId !== null && run.sandboxId.length > 0,
			"POST /runs run.sandboxId populated (proves the engine accepted the dispatch)",
		);
		assertTrue(
			typeof run.sandboxRunId === "string" &&
				run.sandboxRunId !== null &&
				run.sandboxRunId.length > 0,
			"POST /runs run.sandboxRunId populated",
		);
		assertEqual(created.sandbox.id, run.sandboxId, "response.sandbox.id matches run.sandboxId");

		// 3. renderedAgentJson is the frozen pi built-in.
		assertEqual(run.renderedAgentJson.name, "pi", "run.renderedAgentJson.name");
		assertEqual(
			run.renderedAgentJson.frontmatter?.source,
			"builtin",
			"run.renderedAgentJson carries the builtin provenance",
		);

		try {
			// 4. Wait for at least one event to land in the events table.
			// Bridge writes events FIRST then broker.publish (mx-e402e5), so
			// a non-follow GET against the run's events endpoint is the
			// durable signal we want.
			await waitForFirstEvent(http, run.id, FIRST_EVENT_TIMEOUT_MS);

			// 5. Wait for pi `turn_end` accumulation to land on the run row
			// (warren-17a4). The pi PATH shim (pi-path-shim.sh) emits a pi RPC

			// plus token counts, followed by `agent_end`. Warren's bridge
			// (src/runs/stream/bridge.ts) accumulates `turn_end` usage and calls
			// `RunsRepo.attachStats` on `agent_end` — so by the time the
			// run reaches a terminal state, cost_usd / tokens_input /
			// tokens_output MUST be non-null. This is the assertion the

			// via the warren HTTP surface, not just in unit tests.
			const final = await waitForPiUsage(http, run.id, PI_USAGE_TIMEOUT_MS);
			assertTrue(
				typeof final.tokensInput === "number" && final.tokensInput > 0,
				`run.tokens_input should be > 0 after pi turn_end; got ${JSON.stringify(final.tokensInput)}`,
			);
			assertTrue(
				typeof final.tokensOutput === "number" && final.tokensOutput > 0,
				`run.tokens_output should be > 0 after pi turn_end; got ${JSON.stringify(final.tokensOutput)}`,
			);
		} finally {
			// 6. Cancel — cancel is idempotent (mx-fadaa2), best-effort. The
			// pi stub usually exits on its own before we get here, but the
			// teardown safety net keeps us aligned with scenario 04.
			await safelyCancel(http, run.id, ctx);
		}
	},
};

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	// Other scenarios share the same fixture; tolerate either state
	// (mx-a8d92b).
	const existing = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const found = existing.projects.find((p) => p.gitUrl === gitUrl);
	if (found !== undefined) return found;
	return await http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

/**
 * Poll GET /runs/:id until pi usage columns are populated, or throw on
 * timeout. Both attachStats fire-points (isPiAgentEnd + terminal
 * detection) target the same row, so the first non-null read wins.
 */

/**
 * Poll GET /runs/:id until pi usage columns are populated, or throw on
 * timeout. Both attachStats fire-points (isPiAgentEnd + terminal
 * detection) target the same row, so the first non-null read wins.
 */
async function waitForPiUsage(http: WarrenHttp, runId: string, timeoutMs: number) {
	try {
		return await waitForRunPredicate(
			http,
			runId,
			(row) => typeof row.tokensInput === "number" && typeof row.tokensOutput === "number",
			timeoutMs,
			(row) =>
				`state=${row.state} ` +
				`tokensInput=${JSON.stringify(row.tokensInput)} tokensOutput=${JSON.stringify(row.tokensOutput)}`,
		);
	} catch (err) {
		if (err instanceof AcceptanceError) {
			throw new AcceptanceError(
				`${err.message} — warren's bridge did not accumulate+persist the pi turn_end usage envelope`,
			);
		}
		throw err;
	}
}

async function safelyCancel(http: WarrenHttp, runId: string, ctx: ScenarioCtx): Promise<void> {
	try {
		await http.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`, { body: {} });
	} catch (err) {
		ctx.logger.debug(
			`scenario-16: cancel failed (${err instanceof Error ? err.message : String(err)}) — best-effort`,
		);
	}
}
