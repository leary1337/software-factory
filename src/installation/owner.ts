import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireFileLock, FileLockBusyError } from "../locks/file-lock.ts";
import { hasPendingActivation } from "./activation.ts";

export const RESTORE_DISABLED = "restore-queue-disabled.json";
const ID_FILE = "installation-id";
export interface InstallationLease {
	readonly installationId: string;
	release(): void;
	activate(): void;
}

/** The identity is copied with backups; the OS lock lives outside the copied tree. */
export function installationIdentity(dataDir: string): string {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, ID_FILE);

	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
	try {
		linkSync(temporary, path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	} finally {
		unlinkSync(temporary);
	}

	const id = readFileSync(path, "utf8").trim();
	if (!/^[a-f0-9-]{36}$/.test(id))
		throw new Error("Installation identity is invalid; restore a verified backup");
	return id;
}

export function acquireInstallationOwner(
	dataDir: string,
	options: { lockRoot?: string; allowDisabled?: boolean; databaseKey?: string } = {},
): InstallationLease {
	if (
		!options.allowDisabled &&
		(existsSync(join(dataDir, RESTORE_DISABLED)) || hasPendingActivation(dataDir))
	)
		throw new Error(
			"Restored queue is disabled. Verify the copy, then run warren state activate before starting it",
		);
	const id = installationIdentity(dataDir);
	const lockRoot = options.lockRoot ?? join(homedir(), ".warren", "owners");
	if (
		resolve(lockRoot) === resolve(dataDir) ||
		resolve(lockRoot).startsWith(`${resolve(dataDir)}/`)
	)
		throw new Error("Owner locks must live outside the data directory");
	mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
	const releases: (() => void)[] = [];
	const release = () => {
		for (const unlock of releases.splice(0)) unlock();
	};
	const activeFile = join(lockRoot, `${id}.active`);
	const keys = [
		id,
		...(options.databaseKey
			? [createHash("sha256").update(canonicalDatabaseKey(options.databaseKey)).digest("hex")]
			: []),
	];
	try {
		for (const key of keys) releases.push(ownerLock(join(lockRoot, `${key}.lock`)));

		if (!options.allowDisabled) {
			if (existsSync(activeFile) && readFileSync(activeFile, "utf8") !== resolve(dataDir))
				throw new Error(
					"Another restored directory is the active installation; this older queue cannot start",
				);
			writeFileSync(activeFile, resolve(dataDir), { mode: 0o600 });
		}
	} catch (error) {
		release();
		throw error;
	}
	let released = false;
	return {
		installationId: id,
		activate() {
			writeFileSync(activeFile, resolve(dataDir), { mode: 0o600 });
		},
		release() {
			if (!released) {
				released = true;
				release();
			}
		},
	};
}

function canonicalDatabaseKey(key: string): string {
	if (/^postgres(?:ql)?:/.test(key)) return key;
	return existsSync(key) ? realpathSync(key) : resolve(key);
}

function ownerLock(path: string): () => void {
	try {
		return acquireFileLock(path);
	} catch (error) {
		if (!(error instanceof FileLockBusyError)) throw error;
		throw new Error(
			"Another process owns this installation or its database. Stop it before starting, copying, or activating the queue",
		);
	}
}
