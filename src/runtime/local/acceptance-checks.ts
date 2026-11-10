import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type {
	AcceptanceArtifact,
	AcceptanceCheck,
	AcceptanceCriterion,
	AcceptanceEvidence,
	AcceptanceSummary,
} from "../../core/acceptance-evidence.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import type { RunSpec } from "../contract.ts";
import { stopAgentProcess } from "./git-pin.ts";
import { QualityGateFailure } from "./quality-gate-failure.ts";
import type { QualityGateWorkspace } from "./quality-gate-workspace.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

type Gate = NonNullable<RunSpec["qualityGate"]>;
type Spawn = (profile: SandboxProfile, command: SpawnCommand) => Promise<SpawnResult>;
const MAX_ARTIFACT_BYTES = 262144;

async function artifact(workspace: string, path: string): Promise<AcceptanceArtifact> {
	const root = await realpath(workspace);
	const file = resolve(root, path);
	if (!file.startsWith(`${root}${sep}`) || (await realpath(file)) !== file)
		throw new Error("Acceptance artifact escapes the checkout or uses a symlink");
	const info = await lstat(file);
	if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES)
		throw new Error("Acceptance artifacts must be regular files at most 256 KiB");
	const bytes = await readFile(file);
	if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("Acceptance artifact grew beyond 256 KiB");
	const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	return {
		path,
		bytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		text: png ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		imageDataUrl: png ? `data:image/png;base64,${bytes.toString("base64")}` : null,
	};
}

async function discard(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	try {
		while (!(await reader.read()).done) {
			/* Drain bounded-memory output. */
		}
	} finally {
		reader.releaseLock();
	}
}

interface CheckInput {
	readonly record: LocalRunRecord;
	readonly workspace: QualityGateWorkspace;
	readonly spawn: Spawn;
	readonly deadline: number;
}

async function executeCheck(input: CheckInput, check: AcceptanceCheck) {
	for (const path of check.artifacts) {
		if (await Bun.file(join(input.workspace.profile.workspace, path)).exists())
			throw new Error(`Acceptance artifact already exists before the check: ${path}`);
	}
	if (input.record.cancelRequested || Date.now() >= input.deadline)
		throw new Error("Acceptance verification cancelled or timed out");
	const proc = await input.spawn(input.workspace.profile, {
		argv: ["/bin/sh", "-c", check.command],
	});
	input.record.proc = proc;
	if (input.record.cancelRequested) proc.cancel();
	let timedOut = false;
	const timer = setTimeout(
		() => {
			timedOut = true;
			proc.cancel();
		},
		Math.max(1, input.deadline - Date.now()),
	);
	try {
		const [exitCode] = await Promise.all([proc.exited, discard(proc.stdout), discard(proc.stderr)]);
		await stopAgentProcess(proc);
		if (timedOut || input.record.cancelRequested)
			throw new Error("Acceptance verification cancelled or timed out");
		await input.workspace.verify();
		const artifacts = await Promise.all(
			check.artifacts.map((path) => artifact(input.workspace.profile.workspace, path)),
		);
		return { exitCode, artifacts };
	} finally {
		clearTimeout(timer);
		await stopAgentProcess(proc);
	}
}

async function verifyCriterion(
	input: CheckInput,
	criterion: AcceptanceCriterion,
	check: AcceptanceCheck | undefined,
	commit: string,
): Promise<AcceptanceEvidence> {
	const base = {
		...criterion,
		commit,
		command: check?.command ?? null,
		browser: check?.browser ?? false,
	};
	if (!check)
		return {
			...base,
			result: "NOT_RUN",
			exitCode: null,
			artifacts: [],
			reason: "No approved check is linked to this criterion.",
		};
	try {
		const result = await executeCheck(input, check);
		return {
			...base,
			...result,
			result: result.exitCode === 0 ? "PASS" : "FAIL",
			reason: result.exitCode === 0 ? null : `Check exited ${result.exitCode}.`,
		};
	} catch (error) {
		return {
			...base,
			result: "FAIL",
			exitCode: null,
			artifacts: [],
			reason: error instanceof Error ? error.message : "Acceptance verification failed.",
		};
	}
}

function requestedCriteria(policy: NonNullable<Gate["acceptance"]>): AcceptanceCriterion[] {
	const requested = [...policy.criteria];
	if (policy.requireBrowser) {
		for (const check of policy.checks.filter((entry) => entry.browser)) {
			if (!requested.some((criterion) => criterion.checkId === check.id))
				requested.push({ criterion: `Rendered interface: ${check.id}`, checkId: check.id });
		}
		if (!policy.checks.some((check) => check.browser))
			requested.push({ criterion: "Rendered interface verification", checkId: null });
	}
	return requested;
}

function completedCheckFailure(criteria: readonly AcceptanceEvidence[]): number | null {
	let failedExit: number | null = null;
	for (const criterion of criteria) {
		if (criterion.result === "PASS") continue;
		if (
			criterion.result !== "FAIL" ||
			criterion.exitCode === null ||
			!Number.isInteger(criterion.exitCode) ||
			criterion.exitCode <= 0 ||
			criterion.exitCode >= 128
		)
			return null;
		failedExit = criterion.exitCode;
	}
	return failedExit;
}

function boundArtifacts(criteria: AcceptanceEvidence[]): AcceptanceEvidence[] {
	if (JSON.stringify(criteria).length <= 950000) return criteria;
	return criteria.map((criterion) => ({
		...criterion,
		artifacts: [],
		result: "FAIL",
		reason: "Combined evidence exceeds the 1 MB event limit.",
	}));
}

/** Runtime receipts use the clean gate checkout; artifacts survive its teardown in events. */
export async function runAcceptanceChecks(
	store: LocalRunStore,
	record: LocalRunRecord,
	gate: Gate,
	workspace: QualityGateWorkspace,
	spawn: Spawn,
	deadline: number,
): Promise<void> {
	const policy = gate.acceptance;
	if (!policy) return;
	const requested = requestedCriteria(policy);
	store.appendEvent(record, {
		kind: "acceptance.started",
		stream: "system",
		payload: { commit: gate.commit },
	});
	const criteria: AcceptanceEvidence[] = [];
	const completed = new Map<string, AcceptanceEvidence>();
	for (const criterion of requested) {
		const check = policy.checks.find((entry) => entry.id === criterion.checkId);
		const previous = check ? completed.get(check.id) : undefined;
		const evidence = previous
			? { ...previous, ...criterion }
			: await verifyCriterion(
					{ record, workspace, spawn, deadline },
					criterion,
					check,
					gate.commit,
				);
		criteria.push(evidence);
		if (check) completed.set(check.id, evidence);
	}
	const bounded = boundArtifacts(criteria);
	const summary: AcceptanceSummary = {
		commit: gate.commit,
		enforced: policy.enforce || policy.requireBrowser,
		verified: criteria.length > 0 && criteria.every((criterion) => criterion.result === "PASS"),
		criteria: bounded,
	};
	const evidence = {
		...summary,
		verified:
			summary.criteria.length > 0 &&
			summary.criteria.every((criterion) => criterion.result === "PASS"),
	};

	store.appendEvent(record, { kind: "acceptance.completed", stream: "system", payload: evidence });
	assertCompletedVerification(
		record.cancelRequested,
		gate.commit,
		evidence,
		policy,
		bounded === criteria,
	);
}

function assertCompletedVerification(
	cancelled: boolean,
	commit: string,
	evidence: AcceptanceSummary,
	policy: NonNullable<Gate["acceptance"]>,
	artifactsAccepted: boolean,
): void {
	const failedExit = completedCheckFailure(evidence.criteria);
	if (!cancelled && artifactsAccepted && failedExit !== null)
		throw new QualityGateFailure(commit, failedExit, "PASS");
	if (
		cancelled ||
		evidence.criteria.some((criterion) => criterion.result === "FAIL") ||
		(policy.enforce && !evidence.verified) ||
		(policy.requireBrowser &&
			!evidence.criteria.some((criterion) => criterion.browser && criterion.result === "PASS"))
	)
		throw new Error("Acceptance criteria were not verified; inspect the runtime evidence.");
}
