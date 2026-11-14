import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import { fixtureGitOrThrow } from "../workspace/git/test-fixture.ts";
import { activateInstallation, backupInstallation, restoreInstallation } from "./backup.ts";
import { assertCompatibleDatabaseFile } from "./database-proof.ts";
import { acquireInstallationOwner } from "./owner.ts";

let root: string, dataDir: string, lockRoot: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "factory-restore-"));
	dataDir = join(root, "original");
	lockRoot = join(root, "owners");
	await mkdir(dataDir);
	const db = await openDatabase({ path: join(dataDir, "warren.db") });
	const repos = createRepos(db);
	await repos.projects.create({
		id: "project",
		gitUrl: "https://github.com/example/test.git",
		localPath: join(root, "checkout"),
		defaultBranch: "main",
	});
	await repos.planRuns.create({
		projectId: "project",
		agentName: "implementer",
		children: [{ seq: 1, seedId: "ticket-1" }],
	});
	await db.close();
	await mkdir(join(root, "checkout"));
	await writeFile(join(root, "checkout", "saved.txt"), "uncommitted work");
	await mkdir(join(dataDir, "local", "gitdirs", "run", "objects", "info"), { recursive: true });
	await writeFile(
		join(dataDir, "local", "gitdirs", "run", "objects", "info", "alternates"),
		join(root, "checkout", ".git", "objects"),
	);
	await writeFile(join(dataDir, "private-token"), "do-not-report-this-secret");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("installation recovery", () => {
	test("refuses a newer database journal before an older binary can boot or activate it", () => {
		const path = join(dataDir, "warren.db");
		const db = new Database(path);
		db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
			"unknown-future-migration",
			Date.now(),
		]);
		db.close();
		expect(() => assertCompatibleDatabaseFile(path)).toThrow("incompatible");
	});

	test("copies external worktree common Git storage and keeps restored commits and pending changes readable", async () => {
		const main = join(root, "main-repository"),
			checkout = join(root, "checkout");
		await rm(checkout, { recursive: true });
		await fixtureGitOrThrow(root, ["init", "-b", "main", main]);
		await writeFile(join(main, "committed.txt"), "saved commit");
		await fixtureGitOrThrow(main, ["add", "."]);
		await fixtureGitOrThrow(main, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"saved",
		]);
		await fixtureGitOrThrow(main, ["worktree", "add", "-b", "task", checkout]);
		await writeFile(join(checkout, "pending.txt"), "pending work");
		const backup = join(root, "backup"),
			restored = join(root, "restored");
		await backupInstallation({ dataDir, destination: backup, lockRoot });
		await restoreInstallation({ backup, destination: restored, lockRoot });
		await activateInstallation({ dataDir: restored, lockRoot });
		await rm(main, { recursive: true, force: true });
		await rm(checkout, { recursive: true, force: true });
		const restoredProject = join(restored, "imported-projects", "0");
		expect((await fixtureGitOrThrow(restoredProject, ["show", "HEAD:committed.txt"])).stdout).toBe(
			"saved commit",
		);
		expect((await fixtureGitOrThrow(restoredProject, ["status", "--porcelain"])).stdout).toContain(
			"pending.txt",
		);
	});

	test("resumes activation after an interruption between atomic file replacements", async () => {
		const backup = join(root, "backup"),
			restored = join(root, "restored");
		await backupInstallation({ dataDir, destination: backup, lockRoot });
		await restoreInstallation({ backup, destination: restored, lockRoot });
		await expect(
			activateInstallation({
				dataDir: restored,
				lockRoot,
				afterWrite: () => {
					throw new Error("simulated interruption");
				},
			}),
		).rejects.toThrow("simulated interruption");
		expect(() => acquireInstallationOwner(restored, { lockRoot })).toThrow("queue is disabled");
		expect((await activateInstallation({ dataDir: restored, lockRoot })).queueEnabled).toBe(true);
		const db = await openDatabase({ path: join(restored, "warren.db") });
		expect((await createRepos(db).projects.require("project")).localPath).toBe(
			join(restored, "imported-projects", "0"),
		);
		await db.close();
	});
	test("treats database symlink aliases as the same owner resource", async () => {
		const alias = join(root, "alias.db");
		await symlink(join(dataDir, "warren.db"), alias);
		const owner = acquireInstallationOwner(dataDir, {
			lockRoot,
			databaseKey: join(dataDir, "warren.db"),
		});
		try {
			expect(() =>
				acquireInstallationOwner(join(root, "other"), { lockRoot, databaseKey: alias }),
			).toThrow("Another process");
		} finally {
			owner.release();
		}
	});

	test("restores nonempty queue, history and saved work without starting it, then transfers the single owner", async () => {
		const backup = join(root, "backup"),
			restored = join(root, "restored");
		const report = await backupInstallation({ dataDir, destination: backup, lockRoot });
		expect(JSON.stringify(report)).not.toContain("do-not-report");
		expect(report.tables.plan_runs).toBe(1);
		await restoreInstallation({ backup, destination: restored, lockRoot });
		expect(() => acquireInstallationOwner(restored, { lockRoot })).toThrow("queue is disabled");
		const originalOwner = acquireInstallationOwner(dataDir, { lockRoot });
		await expect(activateInstallation({ dataDir: restored, lockRoot })).rejects.toThrow(
			"Another process",
		);
		originalOwner.release();
		expect((await activateInstallation({ dataDir: restored, lockRoot })).queueEnabled).toBe(true);
		expect(await readFile(join(restored, "imported-projects", "0", "saved.txt"), "utf8")).toBe(
			"uncommitted work",
		);
		expect(
			await readFile(
				join(restored, "local", "gitdirs", "run", "objects", "info", "alternates"),
				"utf8",
			),
		).toContain(join(restored, "imported-projects", "0"));
		const owner = acquireInstallationOwner(restored, { lockRoot });
		owner.release();
		expect(() => acquireInstallationOwner(dataDir, { lockRoot })).toThrow(
			"older queue cannot start",
		);
		const db = await openDatabase({ path: join(restored, "warren.db") });
		expect((await createRepos(db).projects.require("project")).localPath).toBe(
			join(restored, "imported-projects", "0"),
		);
		expect((await createRepos(db).planRuns.listActive()).length).toBe(1);
		await db.close();
	});
	test("refuses a rollback after the original records a newer action and rejects corrupted work", async () => {
		const backup = join(root, "backup"),
			restored = join(root, "restored");
		await backupInstallation({ dataDir, destination: backup, lockRoot });
		await restoreInstallation({ backup, destination: restored, lockRoot });
		const db = await openDatabase({ path: join(dataDir, "warren.db") });
		await createRepos(db).planRuns.create({
			projectId: "project",
			agentName: "implementer",
			children: [{ seq: 1, seedId: "new-action" }],
		});
		await db.close();
		await expect(activateInstallation({ dataDir: restored, lockRoot })).rejects.toThrow(
			"newer actions",
		);
		await writeFile(join(backup, "imported-projects", "0", "saved.txt"), "damaged");
		await expect(
			restoreInstallation({ backup, destination: join(root, "damaged"), lockRoot }),
		).rejects.toThrow("differ");
	});
	test("releases the OS owner on abrupt process death without a stale PID takeover", async () => {
		const modulePath = join(import.meta.dir, "owner.ts");
		const script = `import {acquireInstallationOwner} from ${JSON.stringify(modulePath)}; const lease=acquireInstallationOwner(${JSON.stringify(dataDir)}, {lockRoot:${JSON.stringify(lockRoot)}}); console.log('owned'); setInterval(()=>{},1000);`;
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		const reader = child.stdout.getReader();
		await reader.read();
		expect(() => acquireInstallationOwner(dataDir, { lockRoot })).toThrow("Another process");
		child.kill("SIGKILL");
		await child.exited;
		const lease = acquireInstallationOwner(dataDir, { lockRoot });
		lease.release();
	});
});
