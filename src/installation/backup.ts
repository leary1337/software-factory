import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyActivation, hasPendingActivation } from "./activation.ts";
import { assertCompatibleDatabase, type DatabaseProof, databaseProof } from "./database-proof.ts";
import { archiveGitDependencies } from "./git-dependencies.ts";
import { acquireInstallationOwner, RESTORE_DISABLED } from "./owner.ts";
import { relocateFiles, snapshotFiles } from "./snapshot-files.ts";

interface BackupManifest {
	version: 1;
	installationId: string;
	createdAt: string;
	sourceRoot: string;
	database: string;
	proof: DatabaseProof;
	files: Record<string, string>;
	projectRoots: Record<string, string>;
}
const MANIFEST = "backup-manifest.json";
function inside(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
async function absent(path: string) {
	if (existsSync(path)) throw new Error("Destination already exists; choose a new directory");
}

/** Run while stopped. One lease prevents boot or a competing snapshot during the copy. */
export async function backupInstallation(input: {
	dataDir: string;
	destination: string;
	databasePath?: string;
	lockRoot?: string;
}) {
	const dataDir = resolve(input.dataDir),
		destination = resolve(input.destination);
	const databasePath = resolve(input.databasePath ?? join(dataDir, "warren.db"));
	if (!inside(dataDir, databasePath))
		throw new Error(
			"Move the local database under the installation data directory before creating a complete backup",
		);
	if (inside(dataDir, destination) || inside(destination, dataDir))
		throw new Error("Backup destination must be separate from the installation");
	await absent(destination);
	const lease = acquireInstallationOwner(dataDir, {
		lockRoot: input.lockRoot,
		databaseKey: databasePath,
	});
	const stage = `${destination}.partial-${randomUUID()}`;
	try {
		const proof = databaseProof(databasePath);
		assertCompatibleDatabase(proof);

		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await cp(dataDir, stage, { recursive: true, dereference: false, preserveTimestamps: true });
		await chmod(stage, 0o700);
		const projectRoots = await copyExternalProjects(dataDir, databasePath, stage);
		const targetDb = join(stage, relative(dataDir, databasePath));
		await rm(targetDb, { force: true });
		await rm(`${targetDb}-wal`, { force: true });
		await rm(`${targetDb}-shm`, { force: true });
		const db = new Database(databasePath, { readonly: true });
		try {
			db.run("VACUUM INTO ?", [targetDb]);
		} finally {
			db.close();
		}
		const saved = databaseProof(targetDb);
		if (saved.digest !== proof.digest)
			throw new Error("Installation changed during backup; stop it and try again");
		const manifest: BackupManifest = {
			version: 1,
			installationId: lease.installationId,
			createdAt: new Date().toISOString(),
			sourceRoot: dataDir,
			database: relative(dataDir, databasePath),
			proof,
			files: await snapshotFiles(stage),
			projectRoots,
		};
		await writeFile(join(stage, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
		await writeFile(
			join(stage, RESTORE_DISABLED),
			JSON.stringify({ reason: "Backup copy; queue disabled" }),
			{ mode: 0o600 },
		);
		await rename(stage, destination);
		return {
			destination,
			createdAt: manifest.createdAt,
			tables: proof.tables,
			queueEnabled: false,
		};
	} finally {
		lease.release();
		await rm(stage, { recursive: true, force: true });
	}
}
async function copyExternalProjects(
	root: string,
	path: string,
	stage: string,
): Promise<Record<string, string>> {
	const db = new Database(path, { readonly: true });
	const roots: Record<string, string> = {};
	try {
		const projects = db
			.query<{ id: string; local_path: string }, []>("SELECT id, local_path FROM projects")
			.all();
		for (const project of projects) {
			if (inside(root, project.local_path)) continue;
			const destination = join("imported-projects", String(Object.keys(roots).length));
			await cp(project.local_path, join(stage, destination), {
				recursive: true,
				dereference: false,
				preserveTimestamps: true,
			});
			roots[project.local_path] = destination;
		}
		await archiveGitDependencies(
			root,
			stage,
			projects.map((project) => project.local_path),
			roots,
		);
	} finally {
		db.close();
	}
	return roots;
}

async function readManifest(root: string, pending = false): Promise<BackupManifest> {
	const manifest = JSON.parse(await readFile(join(root, MANIFEST), "utf8")) as BackupManifest;
	if (manifest.version !== 1 || !inside(root, join(root, manifest.database)))
		throw new Error("Backup manifest is invalid");
	const proof = databaseProof(join(root, manifest.database));
	assertCompatibleDatabase(proof);
	if (
		!pending &&
		(proof.digest !== manifest.proof.digest ||
			JSON.stringify(await snapshotFiles(root)) !== JSON.stringify(manifest.files))
	)
		throw new Error("Backup contents differ from the verified snapshot");
	return manifest;
}

export async function restoreInstallation(input: {
	backup: string;
	destination: string;
	lockRoot?: string;
}) {
	const backup = resolve(input.backup),
		destination = resolve(input.destination);
	await absent(destination);
	const stage = `${destination}.restore-${randomUUID()}`;
	const lease = acquireInstallationOwner(backup, { lockRoot: input.lockRoot, allowDisabled: true });
	try {
		const manifest = await readManifest(backup);
		await cp(backup, stage, {
			recursive: true,
			dereference: false,
			preserveTimestamps: true,
		});
		await writeFile(
			join(stage, RESTORE_DISABLED),
			JSON.stringify({
				reason: "Restored copy requires explicit activation",
				restoredAt: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		);
		await readManifest(stage);
		await rename(stage, destination);
		return { destination, queueEnabled: false, tables: manifest.proof.tables };
	} finally {
		lease.release();
		await rm(stage, { recursive: true, force: true });
	}
}

export async function activateInstallation(input: {
	dataDir: string;
	lockRoot?: string;
	allowSourceUnavailable?: boolean;
	afterWrite?: () => void;
}) {
	const root = resolve(input.dataDir);
	const lease = acquireInstallationOwner(root, { lockRoot: input.lockRoot, allowDisabled: true });
	try {
		const manifest = await readManifest(root, hasPendingActivation(root));
		const original = join(manifest.sourceRoot, manifest.database);
		if (manifest.sourceRoot !== root) {
			if (existsSync(original)) {
				if (databaseProof(original).digest !== manifest.proof.digest)
					throw new Error(
						"The original installation recorded newer actions after this backup. Create a fresh backup; do not roll the queue backward",
					);
			} else if (!input.allowSourceUnavailable)
				throw new Error(
					"Original data is unavailable. Inspect the saved action receipts, then explicitly allow activation without the original",
				);
		}
		const replacements: [string, string][] = [
			...Object.entries(manifest.projectRoots)
				.sort(([a], [b]) => b.length - a.length)
				.map(([old, path]): [string, string] => [old, join(root, path)]),
			[manifest.sourceRoot, root],
		];
		const finish = await applyActivation(
			root,
			(stage) => relocateReferences(stage, replacements, join(stage, manifest.database)),
			input.afterWrite,
		);
		lease.activate();
		await rm(join(root, RESTORE_DISABLED), { force: true });
		await finish();
		return { queueEnabled: true, installationId: lease.installationId };
	} finally {
		lease.release();
	}
}

/** Private gitdirs, alternates and manifests carry absolute paths that must move together. */
async function relocateReferences(
	root: string,
	replacements: [string, string][],
	databasePath: string,
) {
	const db = new Database(databasePath);
	try {
		for (const table of ["projects", "runs"]) {
			const columns = db
				.query<{ name: string; type: string }, []>(`PRAGMA table_info(${table})`)
				.all()
				.filter((column) => column.type === "TEXT");
			for (const { name } of columns) {
				if (!/path|json/.test(name)) continue;
				for (const [oldRoot, newRoot] of replacements)
					db.run(
						`UPDATE ${table} SET "${name}" = replace("${name}", ?, ?) WHERE instr("${name}", ?) > 0`,
						[oldRoot, newRoot, oldRoot],
					);
			}
		}
	} finally {
		db.close();
	}
	await relocateFiles(root, replacements);
}
