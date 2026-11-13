import { describe, expect, test } from "bun:test";
import { parseVerdict } from "../../plan-runs/review.ts";
import { detectRuntimeTerminal } from "../../runs/stream/terminal-detect.ts";
import { codexAdapter } from "./codex.ts";
import { createCodexParser } from "./parsers/codex.ts";

describe("codexAdapter", () => {
	test("runs with ChatGPT auth and keeps the task out of argv", () => {
		const command = codexAdapter.buildSpawnCommand?.({
			runId: "r",
			workspacePath: "/repo",
			homePath: "/private-home",
			prompt: "private task",
			pendingMessages: [{ body: "write tests", priority: "high" }],
		});
		expect(command?.argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
		expect(command?.argv).toContain('forced_login_method="chatgpt"');
		expect(command?.argv).toContain("allow_login_shell=false");
		expect(command?.argv).not.toContain("private task");
		expect(command?.env).toMatchObject({ OPENAI_API_KEY: "", CODEX_API_KEY: "" });
		expect(command?.stdin).toContain("[STEERING] (high) write tests");
	});
	test("accepts a model without a price table", () => {
		const command = codexAdapter.buildSpawnCommand?.({
			runId: "r",
			workspacePath: "/repo",
			homePath: "/home",
			frontmatter: { model: "custom-model" },
			prompt: "test",
			pendingMessages: [],
		});
		expect(command?.argv).toContain("custom-model");
	});
});

describe("createCodexParser", () => {
	test("delivers the final verdict and usage through the review and token statistics contracts", () => {
		const parse = createCodexParser();
		const lines = [
			{ type: "thread.started", thread_id: "thread-test" },
			{
				type: "item.completed",
				item: { id: "1", type: "agent_message", text: "Checking the diff" },
			},
			{
				type: "item.completed",
				item: { id: "2", type: "agent_message", text: "VERDICT: PASS\nTests passed" },
			},
			{
				type: "turn.completed",
				usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 },
			},
		];
		const events = lines.flatMap((line) => parse(JSON.stringify(line)));
		const terminal = events.at(-1);
		expect(terminal).toBeDefined();
		if (!terminal) throw new Error("missing terminal");
		expect(detectRuntimeTerminal({ ...terminal, seq: 1, ts: new Date() })).toBe("succeeded");
		const payload = terminal.payload as { result: string; session_id: string };
		expect(parseVerdict(payload.result)).toBe("PASS");
		expect(terminal.payload).toMatchObject({
			usage: { input_tokens: 600, output_tokens: 200, cache_read_input_tokens: 400 },
		});
		expect(terminal.payload).not.toHaveProperty("total_cost_usd");
		expect(payload.session_id).toBe("thread-test");
	});

	test("keeps failures failed and isolates concurrent process state", () => {
		const first = createCodexParser();
		const second = createCodexParser();
		first(
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
		);
		const failed = second(
			JSON.stringify({ type: "turn.failed", error: { message: "quota exhausted" } }),
		)[0];
		expect(failed?.payload).toMatchObject({
			result: "",
			is_error: true,
			error: { message: "quota exhausted" },
		});
		if (!failed) throw new Error("missing failure");
		expect(detectRuntimeTerminal({ ...failed, seq: 1, ts: new Date() })).toBe("failed");
	});

	test("normalizes shell commands and file edits without accepting arbitrary terminal output", () => {
		const parse = createCodexParser();
		expect(parse("not json")).toEqual([]);
		expect(parse("[]")).toEqual([]);
		expect(parse('{"type":"result","is_error":false}')[0]?.kind).toBe("telemetry");
		const use = parse(
			JSON.stringify({
				type: "item.started",
				item: { type: "command_execution", id: "cmd", command: "bun test" },
			}),
		);
		expect(use[0]?.payload).toMatchObject({
			name: "Bash",
			id: "cmd",
			input: { command: "bun test" },
		});
		const result = parse(
			JSON.stringify({
				type: "item.completed",
				item: { type: "command_execution", id: "cmd", exit_code: 1, aggregated_output: "failure" },
			}),
		);
		expect(result[0]?.payload).toMatchObject({ tool_use_id: "cmd", is_error: true });
		const edits = parse(
			JSON.stringify({
				type: "item.completed",
				item: { type: "file_change", id: "edit", changes: [{ path: "a.ts" }, null] },
			}),
		);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.payload).toMatchObject({ name: "Edit", input: { file_path: "a.ts" } });
	});
	test("ignores malformed usage without fabricating token totals", () => {
		const parse = createCodexParser();
		for (const usage of [
			{},
			{ input_tokens: -1, output_tokens: 2 },
			{ input_tokens: "3", output_tokens: 2 },
			{ input_tokens: 3, cached_input_tokens: 4, output_tokens: 2 },
		]) {
			const event = parse(JSON.stringify({ type: "turn.completed", usage }))[0];
			expect(event?.payload).not.toHaveProperty("usage");
		}
	});
});
