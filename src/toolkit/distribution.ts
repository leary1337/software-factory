import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "../locks/file-lock.ts";
import { installSkillCatalog } from "../runtime/local/skill-install.ts";
import { installPersonalMcp } from "./install.ts";
import { assertToolkitDependencies } from "./verification.ts";
import {
	activateToolkitVersion,
	resolveToolkitBundle,
	toolkitSkillPack,
	toolkitStoreRoot,
	toolkitUpdateLock,
} from "./versions.ts";

const targetFile = () => join(toolkitStoreRoot(), "personal-target.json");

/** Enrollment is explicit; an HTTP update never guesses a person's home directory. */
export async function enrollPersonalToolkit(home: string, version: string): Promise<void> {
	await withFileLock(toolkitUpdateLock(), async () => {
		await deliverToolkit(version, resolve(home));
		const temporary = `${targetFile()}.${crypto.randomUUID()}`;
		try {
			await writeFile(temporary, `${JSON.stringify({ home: resolve(home) })}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			await rename(temporary, targetFile());
		} finally {
			await rm(temporary, { force: true });
		}
	});
}

async function registeredHome(): Promise<string | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(targetFile(), "utf8"));
		if (!value || typeof value !== "object" || !("home" in value) || typeof value.home !== "string")
			throw new Error("Invalid personal toolkit registration");
		return value.home;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function snapshot(paths: readonly string[]) {
	return Promise.all(
		[...new Set(paths)].map(async (path) => {
			try {
				const stat = await lstat(path);
				return { path, body: await readFile(path), mode: stat.mode & 0o777 };
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT")
					return { path, body: undefined, mode: 0o600 };
				throw error;
			}
		}),
	);
}

/** Restore exact pre-update files if any delivery fails; active version changes last. */
async function deliverToolkit(version: string, home?: string): Promise<void> {
	const packDir = await toolkitSkillPack(version);
	const bundle = resolveToolkitBundle(version);
	assertToolkitDependencies(bundle.catalog);
	if (!home) {
		await activateToolkitVersion(version);
		return;
	}
	const reports = await Promise.all(
		(["agents", "claude"] as const).map((format) =>
			installSkillCatalog({
				homePath: home,
				packDir,
				format,
				audience: "personal",
				browserCliVersion: bundle.catalog.playwright.cliVersion,
			}),
		),
	);
	const conflicts = reports.flatMap((report) => report.conflicts);
	if (conflicts.length)
		throw new Error(`Preserve personal skill changes before updating: ${conflicts.join(", ")}`);
	const mcp = await installPersonalMcp(home, false, bundle, version);
	const backups = await snapshot([
		...reports.flatMap((report) =>
			[...report.writes, ...report.removals].map((path) => join(home, path)),
		),
		join(home, ".agents/factory-skills.json"),
		join(home, ".claude/factory-skills.json"),
		join(home, ".agents/factory-mcp.json"),
		...mcp.writes,
	]);
	try {
		for (const format of ["agents", "claude"] as const)
			await installSkillCatalog({
				homePath: home,
				packDir,
				browserCliVersion: bundle.catalog.playwright.cliVersion,
				format,
				audience: "personal",
				apply: true,
			});
		await installPersonalMcp(home, true, bundle, version);
		await activateToolkitVersion(version);
	} catch (error) {
		for (const backup of backups) {
			if (!backup.body) {
				await rm(backup.path, { force: true });
				continue;
			}
			await mkdir(dirname(backup.path), { recursive: true });
			const temporary = `${backup.path}.restore-${crypto.randomUUID()}`;
			await writeFile(temporary, backup.body, { mode: backup.mode });
			await rename(temporary, backup.path);
		}
		throw error;
	}
}

export async function applyToolkitVersion(version: string): Promise<void> {
	await withFileLock(toolkitUpdateLock(), async () => {
		await deliverToolkit(version, await registeredHome());
	});
}
