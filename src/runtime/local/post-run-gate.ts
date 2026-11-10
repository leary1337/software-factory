/**
 * The post-run quality gate (docs/design/post-run-quality-gate.md): once the
 * agent exits cleanly, the drive loop runs the project's `qualityGate`
 * command itself, in the run's own sandbox, and records the result as a
 * `quality_gate` event. No model waits on it and no agent can skip it.
 *
 * It runs with the same profile and command env the agent ran with (same
 * workspace, same network policy and proxy, same toolchain), so whatever the
 * agent installed is still there. It never runs on the host: the spawn goes
 * through the same seam the agent did (`runSandboxed`, or the docker seam).
 *
 * Armed per run by two facts the domain already carries: the agent's
 * frontmatter says `qualityGate: warren`, and the project configured a
 * command (`WARREN_QUALITY_GATE` in the run env). Either missing leaves the
 * run byte-identical to before.
 */

import { extractAgentEventEnvelope } from "../../core/event-envelope.ts";
import {
	QUALITY_GATE_EVENT_KIND,
	QUALITY_GATE_LOG_TAIL_BYTES,
	type QualityGateFinishedPayload,
} from "../../core/quality-gate.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { AdapterRuntimeEvent, AgentFrontmatter } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { readLines } from "./read-lines.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

/**
 * The gate's time limit. Kept under the watchdog's 45-minute heartbeat: the
 * started event anchors the heartbeat, and the gate emits nothing else until
 * it finishes.
 */
export const POST_RUN_GATE_TIMEOUT_MS = 30 * 60_000;

const SHA_MARKER = "warren-gate-sha:";

/**
 * Print the HEAD the gate is about to judge, then hand the shell to the
 * project's command (`$1`). The marker line is warren's, not the gate's,
 * and is kept out of the recorded log.
 */
const GATE_SCRIPT = `printf '${SHA_MARKER}%s\\n' "$(git rev-parse HEAD 2>/dev/null)"; exec sh -c "$1"`;

export interface PostRunGate {
	readonly command: string;
	readonly timeoutMs: number;
}

/** The gate this run should get, or null when it is not armed. */
export function readPostRunGate(
	spec: RunSpec,
	frontmatter: AgentFrontmatter | undefined,
): PostRunGate | null {
	if (frontmatter?.qualityGate !== "warren") return null;
	const command = spec.env.WARREN_QUALITY_GATE?.trim() ?? "";
	if (command.length === 0) return null;
	return { command, timeoutMs: POST_RUN_GATE_TIMEOUT_MS };
}

/** True when an event is the agent's terminal envelope (`result` / `agent_end`). */
export function isTerminalEnvelope(ev: AdapterRuntimeEvent): boolean {
	const env = extractAgentEventEnvelope(ev);
	return env !== null && (env.type === "result" || env.type === "agent_end");
}

/** True when a held terminal envelope reports the agent itself failed. */
function reportsAgentError(ev: AdapterRuntimeEvent): boolean {
	const env = extractAgentEventEnvelope(ev);
	if (env === null) return false;
	if (env.type === "result") return env.payload.is_error === true;
	if (env.type !== "agent_end") return false;
	const err = env.errorMessage;
	return env.stopReason === "error" || (typeof err === "string" && err.length > 0);
}

/** The gate judges finished work only: a clean exit whose terminal envelope reports no error. */
export function agentFinishedCleanly(
	exitCode: number,
	heldTerminals: readonly AdapterRuntimeEvent[],
): boolean {
	return exitCode === 0 && !heldTerminals.some(reportsAgentError);
}

/** Keeps the last `limit` bytes of everything appended, cut at a line start. */
class TailBuffer {
	#text = "";
	readonly #limit: number;

	constructor(limit: number) {
		this.#limit = limit;
	}

	push(line: string): void {
		this.#text += `${line}\n`;
		if (this.#text.length > this.#limit * 2) this.#trim();
	}

	#trim(): void {
		const cut = this.#text.slice(-this.#limit);
		const firstBreak = cut.indexOf("\n");
		this.#text = firstBreak === -1 ? cut : cut.slice(firstBreak + 1);
	}

	toString(): string {
		if (this.#text.length > this.#limit) this.#trim();
		return this.#text;
	}
}

async function drainLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	for await (const line of readLines(stream)) onLine(line);
}

export interface PostRunGateDeps {
	readonly spawn: (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;
	readonly now?: () => Date;
	/** Test seam for the time limit's timer. */
	readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

const defaultSetTimer = (fn: () => void, ms: number): (() => void) => {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
};

interface GateOutcome {
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly sha: string | null;
	readonly logTail: string;
	readonly error?: string;
}

async function spawnGate(
	record: LocalRunRecord,
	gate: PostRunGate,
	profile: SandboxProfile,
	env: Record<string, string> | undefined,
	deps: PostRunGateDeps,
): Promise<GateOutcome> {
	const command: SpawnCommand = {
		argv: ["sh", "-c", GATE_SCRIPT, "warren-gate", gate.command],
		...(env !== undefined ? { env } : {}),
	};
	let proc: SpawnResult;
	try {
		proc = await deps.spawn(profile, command);
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return { exitCode: null, timedOut: false, sha: null, logTail: "", error };
	}
	// LocalEngine.cancel kills `record.proc`; point it at the gate while it runs.
	record.proc = proc;
	let timedOut = false;
	const clearTimer = (deps.setTimer ?? defaultSetTimer)(() => {
		timedOut = true;
		proc.cancel();
	}, gate.timeoutMs);
	const tail = new TailBuffer(QUALITY_GATE_LOG_TAIL_BYTES);
	let sha: string | null = null;
	const onStdout = (line: string): void => {
		if (sha === null && line.startsWith(SHA_MARKER)) {
			sha = line.slice(SHA_MARKER.length).trim();
			return;
		}
		tail.push(line);
	};
	try {
		const [exitCode] = await Promise.all([
			proc.exited,
			drainLines(proc.stdout, onStdout).catch(() => {}),
			drainLines(proc.stderr, (line) => tail.push(line)).catch(() => {}),
		]);
		return { exitCode: timedOut ? null : exitCode, timedOut, sha, logTail: tail.toString() };
	} finally {
		clearTimer();
	}
}

/**
 * Run the gate in the sandbox and append its two events. Never throws: a
 * spawn failure is recorded on the finished event as `error`, so the run's
 * own outcome stays the agent's.
 */
export async function runPostRunGate(
	store: LocalRunStore,
	record: LocalRunRecord,
	gate: PostRunGate,
	profile: SandboxProfile,
	env: Record<string, string> | undefined,
	deps: PostRunGateDeps,
): Promise<void> {
	const now = deps.now ?? (() => new Date());
	store.appendEvent(
		record,
		{
			kind: QUALITY_GATE_EVENT_KIND,
			stream: "system",
			payload: { type: "quality_gate", phase: "started", command: gate.command },
		},
		now,
	);
	const startedAt = now().getTime();
	const outcome = await spawnGate(record, gate, profile, env, deps);
	const payload: QualityGateFinishedPayload = {
		type: "quality_gate",
		phase: "finished",
		command: gate.command,
		durationMs: Math.max(0, now().getTime() - startedAt),
		...outcome,
	};
	store.appendEvent(record, { kind: QUALITY_GATE_EVENT_KIND, stream: "system", payload }, now);
}
