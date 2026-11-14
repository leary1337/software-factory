import { dirname, join } from "node:path";
import type { PreparationRecipe } from "../core/preparation.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../sandbox/types.ts";
import { preparationEnvironment } from "./environment.ts";
import { resolvePreparation } from "./recipe.ts";
import {
	isTransientPreparationFailure,
	preparationFailureSignature,
	type ReserveEnvironmentRepair,
} from "./repair.ts";

export interface PreparationOwner {
	cancelRequested: boolean;
	proc?: SpawnResult | null;
}
export interface PreparationInput {
	runId?: string;
	reserveEnvironmentRepair?: ReserveEnvironmentRepair;
	profile: SandboxProfile;
	config?: PreparationRecipe;
	stage: "agent" | "verification";
	runHome: string;
	owner: PreparationOwner;
	spawn(profile: SandboxProfile, command: SpawnCommand): Promise<SpawnResult>;
	emit(kind: string, payload: Record<string, unknown>): void;
}

async function tail(stream: ReadableStream<Uint8Array>): Promise<string> {
	let output = "";
	const decoder = new TextDecoder();
	for await (const chunk of stream)
		output = (output + decoder.decode(chunk, { stream: true })).slice(-8000);
	return (output + decoder.decode()).slice(-8000);
}

async function execute(
	input: PreparationInput,
	profile: SandboxProfile,
	argv: string[],
	deadline: number,
): Promise<string> {
	if (input.owner.cancelRequested) throw new Error("Preparation cancelled");
	if (Date.now() >= deadline) throw new Error("Preparation timed out");
	const proc = await input.spawn(profile, { argv });
	input.owner.proc = proc;
	if (input.owner.cancelRequested) proc.cancel();
	let expired = false;
	const timer = setTimeout(
		() => {
			expired = true;
			proc.cancel();
		},
		Math.max(1, deadline - Date.now()),
	);
	try {
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			tail(proc.stdout),
			tail(proc.stderr),
		]);
		if (input.owner.cancelRequested) throw new Error("Preparation cancelled");
		if (expired) throw new Error("Preparation timed out");
		if (code !== 0)
			throw new Error(`Preparation command failed (exit ${code}): ${stderr || stdout}`);
		return stdout || stderr;
	} finally {
		clearTimeout(timer);
		proc.cancel();
		await proc.exited;
	}
}

function matchesVersion(actual: string, required: string): boolean {
	const version = actual.match(/\d+\.\d+(?:\.\d+)?(?:[-\w.]*)?/)?.[0];
	const expected = required.replace(/^v/, "");
	return version === expected || Boolean(version?.startsWith(`${expected}.`));
}

async function reserveRepair(
	input: PreparationInput,
	repairs: { count: number },
	reason: string,
	error: unknown,
): Promise<void> {
	const attempt = repairs.count + 1;
	const signature = preparationFailureSignature(reason);
	try {
		if (!input.runId || !input.reserveEnvironmentRepair)
			throw new Error("Environment repair requires an approved task budget");
		if (attempt > 2)
			throw new Error("Environment repair limit exhausted for this preparation stage");
		await input.reserveEnvironmentRepair(input.runId, input.stage, attempt, reason);
	} catch (stopped) {
		const message = stopped instanceof Error ? stopped.message : String(stopped);
		input.emit("preparation.repair_stopped", {
			stage: input.stage,
			attempt,
			signature,
			reason: message,
		});
		throw new Error(message, { cause: error });
	}
	repairs.count = attempt;
	input.emit("preparation.repair_started", {
		stage: input.stage,
		attempt,
		signature,
		reason,
		action: "Retry the current dependency command in the same workspace; preserve source changes",
	});
}

async function executeStep(
	input: PreparationInput,
	profile: SandboxProfile,
	argv: string[],
	deadline: number,
	repairs: { count: number },
): Promise<void> {
	for (;;) {
		try {
			await execute(input, profile, argv, deadline);
			return;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (input.owner.cancelRequested || !isTransientPreparationFailure(reason)) throw error;
			await reserveRepair(input, repairs, reason, error);
		}
	}
}

/** Preparation failures belong to the environment stage; no agent is launched after a failure. */
export async function runPreparation(input: PreparationInput): Promise<SandboxProfile> {
	const startedAt = Date.now();
	const deadline =
		startedAt +
		Math.min(
			input.config?.timeoutMs ?? 600_000,
			input.profile.timeoutMs ?? Number.POSITIVE_INFINITY,
		);
	const emit = (kind: string, payload: Record<string, unknown>) =>
		input.emit(kind, { stage: input.stage, ...payload });
	try {
		const plan = await resolvePreparation(input.profile.workspace, input.config);
		if (plan.steps.length === 0) return input.profile;
		emit("preparation.started", { recipe: plan.recipe, inputDigest: plan.inputDigest });
		const prepared = await preparationEnvironment(
			input.profile,
			plan,
			input.config,
			join(dirname(dirname(input.runHome)), "download-cache"),
		);
		for (const [name, version] of Object.entries(plan.versions)) {
			const binary = prepared.executables[name as keyof typeof prepared.executables];
			if (!binary) throw new Error(`Preparation tool '${name}' is unavailable`);
			const actual = await execute(input, prepared.profile, [binary, "--version"], deadline);
			if (!matchesVersion(actual, version))
				throw new Error(
					`Preparation requires ${name} ${version}; installed version is ${actual.trim().slice(0, 100)}`,
				);
		}
		const repairs = { count: 0 };
		for (const step of plan.steps) {
			const binary = prepared.executables[step.tool];
			if (!binary) throw new Error(`Preparation tool '${step.tool}' is unavailable`);
			await executeStep(input, prepared.profile, [binary, ...step.args], deadline, repairs);
		}
		emit("preparation.completed", {
			recipe: plan.recipe,
			inputDigest: plan.inputDigest,
			durationMs: Date.now() - startedAt,
		});
		return prepared.profile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emit("preparation.failed", {
			message,
			durationMs: Date.now() - startedAt,
			transient: isTransientPreparationFailure(message),
		});
		throw new Error(`Environment preparation failed: ${message}`, { cause: error });
	}
}
