import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateTransitionError } from "../core/errors.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";

export interface DeploymentIntent {
	readonly ownerRunId: string | null;
	readonly workflow: string;
	readonly branch: string;
	readonly requestedAt: string;
	readonly previousRunIds: readonly number[];
}
export interface DeploymentAdmission {
	withLock<T>(projectId: string, work: () => Promise<T>): Promise<T>;
	read(projectId: string): Promise<DeploymentIntent | null>;
	write(projectId: string, intent: DeploymentIntent): Promise<void>;
	clear(projectId: string): Promise<void>;
}

/** One boot-shared admission boundary for manual and automatic delivery. */
export function createDeploymentAdmission(
	options: { directory?: string } = {},
): DeploymentAdmission {
	const memory = new Map<string, DeploymentIntent>();
	const locks = new Map<string, Promise<unknown>>();
	const path = (projectId: string) =>
		join(options.directory ?? "", `${createHash("sha256").update(projectId).digest("hex")}.json`);
	return {
		async withLock(projectId, work) {
			const previous = locks.get(projectId) ?? Promise.resolve();
			const pending = previous.catch(() => {}).then(work);
			locks.set(projectId, pending);
			try {
				return await pending;
			} finally {
				if (locks.get(projectId) === pending) locks.delete(projectId);
			}
		},
		async read(projectId) {
			if (options.directory === undefined) return memory.get(projectId) ?? null;
			let source: string;
			try {
				source = await readFile(path(projectId), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
			const value = JSON.parse(source) as DeploymentIntent;
			if (
				typeof value.workflow !== "string" ||
				typeof value.branch !== "string" ||
				!Array.isArray(value.previousRunIds) ||
				!Number.isFinite(Date.parse(value.requestedAt)) ||
				!(value.ownerRunId === null || typeof value.ownerRunId === "string")
			)
				throw new StateTransitionError(
					"Stored deployment intent is invalid; operator inspection required",
				);
			return value;
		},
		async write(projectId, intent) {
			if (options.directory === undefined) {
				memory.set(projectId, intent);
				return;
			}
			await mkdir(options.directory, { recursive: true, mode: 0o700 });
			const temporary = `${path(projectId)}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(intent), { mode: 0o600, flag: "wx" });
				await rename(temporary, path(projectId));
			} finally {
				await rm(temporary, { force: true });
			}
		},
		async clear(projectId) {
			memory.delete(projectId);
			if (options.directory !== undefined) await rm(path(projectId), { force: true });
		},
	};
}

/** Tests/unwired embeddings share a process boundary; the server supplies durable storage. */
export const DEFAULT_DEPLOYMENT_ADMISSION = createDeploymentAdmission();

export async function ensureDeploymentAdmission(
	admission: DeploymentAdmission,
	projectId: string,
	deploys: ForgeDeploys,
	ref: RepoRef,
	ownerRunId?: string,
): Promise<void> {
	const receipt = await admission.read(projectId);
	if (receipt === null || (ownerRunId !== undefined && receipt.ownerRunId === ownerRunId)) return;
	if (receipt.ownerRunId !== null)
		throw new StateTransitionError(
			"Automatic production verification is unresolved for this project",
		);
	const listed = await deploys.listRuns(ref, receipt.workflow, 100);
	if (!listed.ok)
		throw new StateTransitionError("Cannot reconcile the previous deployment request");
	const observed = listed.value.filter(
		(run) =>
			!receipt.previousRunIds.includes(run.id) &&
			Date.parse(run.createdAt) >= Date.parse(receipt.requestedAt) - 1000,
	);
	if (observed.length === 0 || observed.some((run) => run.status !== "completed"))
		throw new StateTransitionError(
			"The previous deployment request is unconfirmed or still running. Inspect GitHub before retrying.",
		);
	await admission.clear(projectId);
}
