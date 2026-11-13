import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ReviewCheckResult, ReviewFinding } from "../../core/review-findings.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { RunSpec } from "../contract.ts";
import { MAX_REVIEW_BYTES, parseReviewManifest, REVIEW_MANIFEST } from "../review-artifacts.ts";
import { stopAgentProcess } from "./git-pin.ts";
import type { QualityGateWorkspace } from "./quality-gate-workspace.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

type Spawn = (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;

export async function collectReviewFindings(
	home: string,
	prior: readonly ReviewFinding[],
): Promise<ReviewFinding[]> {
	const file = await open(join(home, REVIEW_MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_REVIEW_BYTES)
			throw new Error("Invalid review manifest size or mode");
		return parseReviewManifest(await file.readFile("utf8"), prior);
	} finally {
		await file.close();
	}
}

async function tail(stream: ReadableStream<Uint8Array>): Promise<string> {
	let text = "";
	const decoder = new TextDecoder();
	for await (const chunk of stream)
		text = (text + decoder.decode(chunk, { stream: true })).slice(-4000);
	return (text + decoder.decode()).slice(-4000);
}

async function executeReproduction(
	record: LocalRunRecord,
	finding: ReviewFinding,
	workspace: QualityGateWorkspace,
	spawn: Spawn,
	deadline: number,
): Promise<ReviewCheckResult> {
	const directory = await mkdtemp(join(workspace.profile.workspace, ".warren-repro-"));
	let proc: SpawnResult | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	try {
		for (const file of finding.files)
			await writeFile(join(directory, file.path), file.contents, { flag: "wx", mode: 0o400 });
		const profile = workspace.profile;
		const reproPath =
			process.platform === "linux" ? `/workspace/${basename(directory)}` : directory;
		if (record.cancelRequested || Date.now() >= deadline)
			throw new Error("Reproduction cancelled or timed out");
		proc = await spawn(
			{
				...profile,
				setEnv: { ...profile.setEnv, WARREN_REPRO_DIR: reproPath },
				verificationSources: { directory, files: finding.files.map((file) => file.path) },
			},
			{ argv: ["/bin/sh", "-c", finding.command] },
		);
		record.proc = proc;
		if (record.cancelRequested) proc.cancel();
		const running = proc;
		timer = setTimeout(
			() => {
				timedOut = true;
				running.cancel();
			},
			Math.max(1, Math.min(120_000, deadline - Date.now())),
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			tail(proc.stdout),
			tail(proc.stderr),
		]);
		await stopAgentProcess(proc);
		await workspace.verify();
		for (const file of finding.files) {
			if ((await readFile(join(directory, file.path), "utf8")) !== file.contents)
				throw new Error("Reproduction source changed");
		}
		return {
			id: finding.id,
			exitCode,
			stdout,
			stderr,
			...(record.cancelRequested || timedOut
				? { error: "Reproduction cancelled or timed out" }
				: {}),
		};
	} finally {
		clearTimeout(timer);
		await stopAgentProcess(proc);
		await rm(directory, { recursive: true, force: true });
	}
}

export async function runReviewChecks(
	store: LocalRunStore,
	record: LocalRunRecord,
	commit: string,
	findings: readonly ReviewFinding[],
	workspace: QualityGateWorkspace,
	spawn: Spawn,
	deadline: number,
): Promise<void> {
	const results: ReviewCheckResult[] = [];
	for (const finding of findings) {
		store.appendEvent(record, {
			kind: "review_check.started",
			stream: "system",
			payload: { commit, id: finding.id },
		});
		const result = await executeReproduction(record, finding, workspace, spawn, deadline);
		results.push(result);
		store.appendEvent(record, {
			kind: "review_check.completed",
			stream: "system",
			payload: { commit, ...result },
		});
	}
	if (record.cancelRequested) throw new Error("Reproduction cancelled");
	store.appendEvent(record, {
		kind: "review_check.evidence",
		stream: "system",
		payload: { commit, findings, results },
	});
}

export async function prepareReviewChecks(
	store: LocalRunStore,
	record: LocalRunRecord,
	gate: NonNullable<RunSpec["qualityGate"]>,
) {
	const findings =
		gate.reviewFindings === undefined
			? undefined
			: await collectReviewFindings(record.homePath, gate.reviewFindings);
	if (findings)
		store.appendEvent(record, {
			kind: "review_check.artifacts",
			stream: "system",
			payload: { commit: gate.commit, findings },
		});
	return async (workspace: QualityGateWorkspace, spawn: Spawn, deadline: number) => {
		if (findings)
			await runReviewChecks(store, record, gate.commit, findings, workspace, spawn, deadline);
	};
}
