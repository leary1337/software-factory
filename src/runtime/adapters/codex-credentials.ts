import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const activeSources = new Set<string>();

/** File-backed ChatGPT login; never copy the user's config, plugins or transcripts. */
export function codexAuthFile(): string {
	return (
		process.env.WARREN_CODEX_AUTH_FILE ??
		join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")
	);
}

async function readAuth(path: string): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if ((await file.stat()).size > 65_536) throw new Error("Codex auth file is too large");
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

function account(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Codex auth file is not valid JSON; run codex login again");
	}
	const value = parsed as {
		auth_mode?: unknown;
		tokens?: { account_id?: unknown; access_token?: unknown; refresh_token?: unknown };
	};
	const tokens = value?.tokens;
	if (
		value?.auth_mode !== "chatgpt" ||
		!nonEmpty(tokens?.account_id) ||
		!nonEmpty(tokens?.access_token) ||
		!nonEmpty(tokens?.refresh_token)
	) {
		throw new Error(
			"Warren requires a ChatGPT login: run codex login with file credential storage",
		);
	}
	return tokens.account_id;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

async function writeAuth(path: string, body: string): Promise<void> {
	const temp = `${path}.${crypto.randomUUID()}.tmp`;
	const file = await open(temp, "wx", 0o600);
	try {
		await file.writeFile(body, "utf8");
		await file.close();
		await rename(temp, path);
	} finally {
		await file.close();
		await rm(temp, { force: true });
	}
}

/** Persist token rotation only if the source login still matches the one lent to this run. */
export async function prepareCodexCredentials(
	homePath: string,
	source = codexAuthFile(),
): Promise<() => Promise<void>> {
	const key = await realpath(source).catch(() => source);
	if (activeSources.has(key)) {
		throw new Error("Codex login is already in use by Warren; set concurrency to one");
	}
	activeSources.add(key);
	try {
		const finish = await lendCredentials(homePath, source);
		let finished = false;
		return async () => {
			if (finished) return;
			finished = true;
			try {
				await finish();
			} finally {
				activeSources.delete(key);
			}
		};
	} catch (error) {
		activeSources.delete(key);
		throw error;
	}
}

async function lendCredentials(homePath: string, source: string): Promise<() => Promise<void>> {
	let original: string;
	try {
		original = await readAuth(source);
	} catch {
		throw new Error(
			"Codex ChatGPT login is unavailable. Run codex login -c cli_auth_credentials_store='\"file\"', or set WARREN_CODEX_AUTH_FILE",
		);
	}
	const accountId = account(original);
	const target = join(homePath, ".codex", "auth.json");
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const directory = await lstat(dirname(target));
	if (!directory.isDirectory()) throw new Error("Codex home must be a private directory");
	const journal: CredentialJournal = {
		source,
		originalHash: hash(original),
		accountId,
		directoryIno: directory.ino,
		directoryDev: directory.dev,
	};
	// Outside the sandbox-writable HOME: never trust a child-supplied source path.
	await writeAuth(`${homePath}.credentials.json`, JSON.stringify(journal));
	await writeAuth(target, original);
	return () => recoverCodexCredentials(homePath);
}

interface CredentialJournal {
	source: string;
	originalHash: string;
	accountId: string;
	directoryIno: number;
	directoryDev: number;
}

function hash(body: string): string {
	return createHash("sha256").update(body).digest("hex");
}

/** Called only after the runtime has confirmed that the child and its descendants exited. */
export async function recoverCodexCredentials(homePath: string): Promise<void> {
	const path = `${homePath}.credentials.json`;
	let journal: CredentialJournal;
	try {
		journal = JSON.parse(await readAuth(path)) as CredentialJournal;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const target = join(homePath, ".codex", "auth.json");
	const current = await lstat(dirname(target));
	if (
		!current.isDirectory() ||
		current.ino !== journal.directoryIno ||
		current.dev !== journal.directoryDev
	) {
		throw new Error("Codex home was replaced during the run");
	}
	let refreshed: string | undefined;
	try {
		refreshed = await readAuth(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (
		refreshed !== undefined &&
		hash(refreshed) !== journal.originalHash &&
		account(refreshed) === journal.accountId &&
		hash(await readAuth(journal.source)) === journal.originalHash
	) {
		await writeAuth(journal.source, refreshed);
	}
	// If persistence fails, leave both credential and journal for another recovery attempt.
	await rm(target, { force: true });
	await rm(path, { force: true });
}
