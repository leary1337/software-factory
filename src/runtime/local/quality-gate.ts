/** Host-owned quality-gate execution in a separate checkout through the active spawn boundary. */
import type { ReserveEnvironmentRepair } from "../../preparation/repair.ts";
import { runPreparation } from "../../preparation/run.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { RunSpec } from "../contract.ts";
import { runAcceptanceChecks } from "./acceptance-checks.ts";
import { stopAgentProcess } from "./git-pin.ts";
import { QualityGateFailure } from "./quality-gate-failure.ts";
import { prepareQualityGateWorkspace } from "./quality-gate-workspace.ts";
import { prepareReviewChecks } from "./review-checks.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

interface GateDeps {
	readonly reserveEnvironmentRepair?: ReserveEnvironmentRepair;
	readonly spawn: (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;
	readonly prepareWorkspace?: typeof prepareQualityGateWorkspace;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let tail = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-8000);
		}
		return (tail + decoder.decode()).slice(-8000);
	} finally {
		reader.releaseLock();
	}
}

export async function runIndependentQualityGate(
	store: LocalRunStore,
	record: LocalRunRecord,
	gate: NonNullable<RunSpec["qualityGate"]>,
	profile: SandboxProfile,
	commandEnv: Record<string, string> | undefined,
	deps: GateDeps,
): Promise<void> {
	const startedAt = Date.now();
	const timeoutMs = profile.timeoutMs ?? 1_200_000;
	const deadline = startedAt + timeoutMs;
	if (record.cancelRequested) throw new Error("quality gate cancelled");
	if (!gate.command.trim() || !/^[a-f0-9]{40}$/.test(gate.commit))
		throw new Error("Independent review requires a configured qualityGate and pinned commit");
	await stopAgentProcess(record.proc);
	if (record.cancelRequested) throw new Error("quality gate cancelled");
	const checkFindings = await prepareReviewChecks(store, record, gate);
	let workspace = await (deps.prepareWorkspace ?? prepareQualityGateWorkspace)(
		profile,
		gate.commit,
		commandEnv,
	);
	let proc: SpawnResult | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let timedOut = false;

	try {
		if (record.cancelRequested) throw new Error("quality gate cancelled");
		workspace = {
			...workspace,
			profile: await runPreparation({
				runId: record.runId,
				reserveEnvironmentRepair: deps.reserveEnvironmentRepair,
				profile: { ...workspace.profile, timeoutMs: Math.max(1, deadline - Date.now()) },
				config: gate.preparation,
				stage: "verification",
				runHome: record.homePath,
				owner: record,
				spawn: deps.spawn,
				emit: (kind, payload) => {
					store.appendEvent(record, { kind, stream: "system", payload });
				},
			}),
		};
		store.appendEvent(record, {
			kind: "quality_gate.started",
			stream: "system",
			payload: { commit: gate.commit, command: gate.command },
		});
		if (Date.now() >= deadline)
			throw new Error("Independent quality gate timed out during preparation");
		proc = await deps.spawn(workspace.profile, { argv: ["/bin/sh", "-c", gate.command] });
		record.proc = proc;
		if (record.cancelRequested) proc.cancel();
		const running = proc;
		timer = setTimeout(
			() => {
				timedOut = true;
				running.cancel();
			},
			Math.max(1, deadline - Date.now()),
		);
		heartbeat = setInterval(
			() =>
				store.appendEvent(record, {
					kind: "quality_gate.progress",
					stream: "system",
					payload: { elapsedMs: Date.now() - startedAt },
				}),
			15_000,
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			drain(proc.stdout),
			drain(proc.stderr),
		]);
		await stopAgentProcess(proc);
		if (record.cancelRequested || timedOut)
			throw new Error("Independent quality gate cancelled or timed out");
		await workspace.verify();
		if (record.cancelRequested || timedOut)
			throw new Error("Independent quality gate cancelled or timed out");
		store.appendEvent(record, {
			kind: "quality_gate.completed",
			stream: "system",
			payload: {
				commit: gate.commit,
				command: gate.command,
				exitCode,
				durationMs: Date.now() - startedAt,
				stdout,
				stderr,
			},
		});
		clearTimeout(timer);
		await checkFindings(workspace, deps.spawn, deadline);
		if (exitCode !== 0) throw new QualityGateFailure(gate.commit, exitCode);
		await runAcceptanceChecks(store, record, gate, workspace, deps.spawn, deadline);
	} finally {
		clearTimeout(timer);
		clearInterval(heartbeat);
		// Preserve the disposable tree if teardown cannot prove that writers stopped.
		await stopAgentProcess(record.proc);
		await workspace.cleanup();
	}
}
