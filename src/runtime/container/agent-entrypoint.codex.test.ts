import { describe, expect, test } from "bun:test";
import { codexAdapter } from "../adapters/codex.ts";
import {
	EXIT_FINALIZE_NOT_DELIVERED,
	parseAgentEntrypointEnv,
	runAgent,
	runAgentEntrypoint,
} from "./agent-entrypoint.ts";
import type { AgentProc } from "./agent-io.ts";

const ENV = parseAgentEntrypointEnv({
	WARREN_RUN_ID: "run_codex_test",
	WARREN_AGENT_RUNTIME: "codex",
	WARREN_PROMPT: "review",
	WARREN_WORKSPACE_PATH: "/workspace",
});
const quiet = () => {};
function processOf(stdout = "", exitCode = 0): AgentProc {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response("").body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
	};
}

describe("Codex entrypoint event integration", () => {
	test("keeps a cancelled run's failed finalization visible to the supervisor", async () => {
		const logs: string[] = [];
		let killed = false;
		const child = {
			...processOf(),
			kill: () => {
				killed = true;
			},
		};
		const code = await runAgentEntrypoint(
			{
				WARREN_RUN_ID: "run_codex_test",
				WARREN_AGENT_RUNTIME: "codex",
				WARREN_PROMPT: "review",
				WARREN_API_URL: "http://127.0.0.1:1",
				WARREN_API_TOKEN: "fake-callback-token",
			},
			{
				registry: { get: () => codexAdapter },
				spawn: async () => child,
				http: { get: async () => ({ status: 200, body: { messages: [] } }) },
				registerCancelSignal: (handler) => handler("SIGTERM"),
				finalize: {
					now: () => {
						throw new Error("finalizer unavailable");
					},
				},
				out: quiet,
				log: (line) => logs.push(line),
			},
		);
		expect(killed).toBe(true);
		expect(code).toBe(EXIT_FINALIZE_NOT_DELIVERED);
		expect(logs.join("\n")).toContain("finalize step failed");
	});

	test("prepares the workspace and isolates final text between successive processes", async () => {
		let prepared = 0;
		const runtime = {
			...codexAdapter,
			prepareWorkspace: async () => {
				prepared++;
			},
		};
		for (const text of ["VERDICT: PASS", ""]) {
			const lines: string[] = [];
			const events = [
				...(text ? [{ type: "item.completed", item: { type: "agent_message", text } }] : []),
				{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 1 } },
			]
				.map((event) => JSON.stringify(event))
				.join("\n");
			const result = await runAgent(ENV, {
				registry: { get: () => runtime },
				spawn: async () => processOf(events),
				out: (line) => lines.push(line),
				log: quiet,
			});
			expect(result.phase).toBe("succeeded");
			const terminal = lines
				.map((line) => JSON.parse(line))
				.find((event) => event.payload?.type === "result");
			expect(terminal.payload).toMatchObject({ runtime: "codex", result: text });
		}
		expect(prepared).toBe(2);
	});

	test("refuses to start an adapter without a command", async () => {
		const lines: string[] = [];
		const result = await runAgent(ENV, {
			registry: { get: () => ({ ...codexAdapter, buildSpawnCommand: undefined }) },
			out: (line) => lines.push(line),
			log: quiet,
		});
		expect(result.phase).toBe("failed");
		expect(lines.join("\n")).toContain("declares no buildSpawnCommand");
	});

	test.each(["stdout", "stderr"] as const)(
		"records a %s read error from a failed child",
		async (stream) => {
			const lines: string[] = [];
			const child = processOf("", 1);
			child[stream] = new ReadableStream({
				start(controller) {
					controller.error(new Error("read failure"));
				},
			});
			const result = await runAgent(ENV, {
				registry: { get: () => codexAdapter },
				spawn: async () => child,
				out: (line) => lines.push(line),
				log: quiet,
			});
			expect(result.phase).toBe("failed");
			expect(lines.join("\n")).toContain("event stream failed: read failure");
		},
	);
});
