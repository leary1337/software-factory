import { describe, expect, test } from "bun:test";
import { readQualityGateResult } from "../../core/quality-gate.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { AgentRuntimeAdapter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { driveLocalRun } from "./drive.ts";
import { POST_RUN_GATE_TIMEOUT_MS, runPostRunGate } from "./post-run-gate.ts";
import { LocalRunStore } from "./run-store.ts";

const PROFILE: SandboxProfile = {
	workspace: "/tmp/ws",
	home: "/tmp/home",
	readOnlyMounts: [],
	network: "open",
	allowedDomains: [],
	envPassthrough: [],
	setEnv: {},
	toolchainPaths: [],
};

function scriptedProc(stdout: readonly string[], exitCode: number, stderr: readonly string[] = []) {
	const encoder = new TextEncoder();
	const stream = (lines: readonly string[]) =>
		new ReadableStream<Uint8Array>({
			start(ctrl) {
				for (const line of lines) ctrl.enqueue(encoder.encode(`${line}\n`));
				ctrl.close();
			},
		});
	const state = { cancelled: false };
	const proc: SpawnResult = {
		pid: 1,
		stdout: stream(stdout),
		stderr: stream(stderr),
		exited: Promise.resolve(exitCode),
		cancel: () => {
			state.cancelled = true;
		},
	};
	return { proc, state };
}

const line = (kind: string, stream: string, payload: unknown) =>
	JSON.stringify({ kind, stream, payload });
const AGENT_TEXT = line("text", "stdout", { text: "committed" });
const AGENT_RESULT = line("state_change", "system", { type: "result", result: "done" });
const AGENT_ERROR = line("state_change", "system", { type: "result", is_error: true });

const ADAPTER = {
	runtimeId: "fake",
	harnessStatePrefixes: [],
	terminalErrorEnvelopeTypes: [],
	buildSpawnCommand: () => ({ argv: ["fake"], stdin: "do it" }),
	parseEvents: (raw: string) => [JSON.parse(raw)],
} as unknown as AgentRuntimeAdapter;

function makeSpec(armed: boolean, gate: string | null = "pnpm check"): RunSpec {
	return {
		runId: "run_gate1",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/run_gate1",
		baseBranch: "main",
		runtimeId: "fake" as RunSpec["runtimeId"],
		prompt: "do it",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: gate === null ? {} : { WARREN_QUALITY_GATE: gate },
		metadata: { frontmatter: armed ? { qualityGate: "warren" } : {} },
	};
}

async function drive(
	spec: RunSpec,
	agent: { stdout: readonly string[]; exitCode?: number },
	gate: () => Promise<SpawnResult>,
) {
	const store = new LocalRunStore();
	const record = store.create({
		runId: spec.runId,
		sandboxId: `local-${spec.runId}`,
		workspacePath: "/tmp/ws",
		homePath: "/tmp/home",
		branch: spec.branch,
	});
	const spawns: SpawnCommand[] = [];
	await driveLocalRun(store, record, spec, PROFILE, {
		registry: { get: () => ADAPTER },
		spawn: (_profile, command) => {
			spawns.push(command);
			if (spawns.length === 1) {
				return Promise.resolve(scriptedProc(agent.stdout, agent.exitCode ?? 0).proc);
			}
			return gate();
		},
	});
	const events = record.events.map((ev) => ({
		kind: ev.kind,
		type: (ev.payload as { type?: string; phase?: string }).type,
		phase: (ev.payload as { phase?: string }).phase,
	}));
	const finished = record.events
		.map((ev) => readQualityGateResult(ev.payload))
		.find((r) => r !== null);
	return { record, spawns, events, finished };
}

const greenGate = () =>
	Promise.resolve(scriptedProc(["warren-gate-sha:abc123", "lint ok", "tests ok"], 0).proc);

describe("driveLocalRun post-run gate", () => {
	test("runs the gate after a clean agent and records it before the terminal envelope", async () => {
		const { record, spawns, events, finished } = await drive(
			makeSpec(true),
			{ stdout: [AGENT_TEXT, AGENT_RESULT] },
			greenGate,
		);
		expect(spawns).toHaveLength(2);
		expect(spawns[1]?.argv.at(-1)).toBe("pnpm check");
		expect(spawns[1]?.argv.slice(0, 2)).toEqual(["sh", "-c"]);
		expect(events.map((e) => e.phase ?? e.type ?? e.kind)).toEqual([
			"text",
			"started",
			"finished",
			"result",
		]);
		expect(finished).toMatchObject({ exitCode: 0, sha: "abc123", timedOut: false });
		expect(finished?.logTail).toBe("lint ok\ntests ok\n");
		expect(record.phase).toBe("succeeded");
	});

	test("a red gate is recorded and leaves the run's own outcome alone", async () => {
		const { record, finished } = await drive(makeSpec(true), { stdout: [AGENT_RESULT] }, () =>
			Promise.resolve(scriptedProc(["warren-gate-sha:abc"], 1, ["Type error: x is never"]).proc),
		);
		expect(finished).toMatchObject({ exitCode: 1, logTail: "Type error: x is never\n" });
		expect(record.phase).toBe("succeeded");
	});

	test("skips the gate when the agent's frontmatter does not arm it", async () => {
		const { spawns, finished } = await drive(
			makeSpec(false),
			{ stdout: [AGENT_RESULT] },
			greenGate,
		);
		expect(spawns).toHaveLength(1);
		expect(finished).toBeUndefined();
	});

	test("skips the gate when the project configured no command", async () => {
		const { spawns } = await drive(makeSpec(true, null), { stdout: [AGENT_RESULT] }, greenGate);
		expect(spawns).toHaveLength(1);
	});

	test("skips the gate after a failed agent but still releases its terminal envelope", async () => {
		const failed = await drive(makeSpec(true), { stdout: [AGENT_ERROR] }, greenGate);
		expect(failed.spawns).toHaveLength(1);
		expect(failed.events.map((e) => e.type)).toEqual(["result"]);

		const crashed = await drive(makeSpec(true), { stdout: [AGENT_RESULT], exitCode: 2 }, greenGate);
		expect(crashed.spawns).toHaveLength(1);
		expect(crashed.record.phase).toBe("failed");
	});

	test("records a gate that could not start as an error, not a verdict", async () => {
		const { finished, events, record } = await drive(
			makeSpec(true),
			{ stdout: [AGENT_RESULT] },
			() => Promise.reject(new Error("sandbox refused")),
		);
		expect(finished).toMatchObject({ exitCode: null, error: "sandbox refused" });
		expect(events.at(-1)?.type).toBe("result");
		expect(record.phase).toBe("succeeded");
	});
});

describe("runPostRunGate", () => {
	test("kills the gate at its time limit and records the timeout", async () => {
		const store = new LocalRunStore();
		const record = store.create({
			runId: "run_t",
			sandboxId: "local-run_t",
			workspacePath: "/tmp/ws",
			homePath: "/tmp/home",
			branch: "b",
		});
		const { proc, state } = scriptedProc(["warren-gate-sha:def"], 137);
		let limit = 0;
		await runPostRunGate(
			store,
			record,
			{ command: "make check", timeoutMs: POST_RUN_GATE_TIMEOUT_MS },
			PROFILE,
			undefined,
			{
				spawn: () => Promise.resolve(proc),
				setTimer: (fn, ms) => {
					limit = ms;
					fn();
					return () => {};
				},
			},
		);
		expect(limit).toBe(POST_RUN_GATE_TIMEOUT_MS);
		expect(state.cancelled).toBe(true);
		expect(record.proc).toBe(proc);
		const result = readQualityGateResult(record.events.at(-1)?.payload);
		expect(result).toMatchObject({ exitCode: null, timedOut: true, sha: "def" });
	});

	test("keeps only the tail of a long log, cut at a line start", async () => {
		const store = new LocalRunStore();
		const record = store.create({
			runId: "run_l",
			sandboxId: "local-run_l",
			workspacePath: "/tmp/ws",
			homePath: "/tmp/home",
			branch: "b",
		});
		const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
		await runPostRunGate(store, record, { command: "c", timeoutMs: 1_000 }, PROFILE, undefined, {
			spawn: () => Promise.resolve(scriptedProc(lines, 1).proc),
		});
		const tail = readQualityGateResult(record.events.at(-1)?.payload)?.logTail ?? "";
		expect(tail.length).toBeLessThanOrEqual(6_000);
		expect(tail.startsWith("line ")).toBe(true);
		expect(tail.endsWith("line 1999 xxxxxxxxxxxxxxxxxxxx\n")).toBe(true);
	});
});
