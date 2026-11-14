import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import { BootCleanup } from "./boot-cleanup.ts";
import { bootServer } from "./index.ts";

test("unwinds an occupied-port startup before releasing ownership or advancing the queue", async () => {
	const root = await mkdtemp(join(tmpdir(), "factory-boot-failure-"));
	const occupied = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("occupied"),
	});
	const env = {
		WARREN_DATA_DIR: root,
		WARREN_API_TOKEN: "fixture-token",
		WARREN_BIND_HOST: "127.0.0.1",
		WARREN_BIND_PORT: String(occupied.port),
		WARREN_DISABLE_UI: "1",
		WARREN_PLAN_RUN_TICK_MS: "10",
		WARREN_SCHEDULER_TICK_MS: "10",
		WARREN_LOG_LEVEL: "silent",
	};
	try {
		const db = await openDatabase({ path: join(root, "warren.db") });
		const repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/example/fixture.git",
			localPath: join(root, "checkout"),
			defaultBranch: "main",
		});
		const queued = await repos.planRuns.create({
			projectId: project.id,
			agentName: "implementer",
			children: [{ seq: 1, seedId: "waiting" }],
		});
		await db.close();
		await expect(bootServer({ env })).rejects.toThrow();
		await Bun.sleep(80);
		const reopened = await openDatabase({ path: join(root, "warren.db") });
		const after = createRepos(reopened);
		expect((await after.planRuns.require(queued.planRun.id)).state).toBe("queued");
		expect((await after.planRuns.listChildren(queued.planRun.id))[0]?.runId).toBeNull();
		expect(await after.runs.countNonTerminal()).toBe(0);
		await reopened.close();
		const server = await bootServer({
			env: {
				...env,
				WARREN_BIND_PORT: "0",
				WARREN_PLAN_RUN_DISABLED: "1",
				WARREN_SCHEDULER_DISABLED: "1",
			},
		});
		expect((await fetch(`${server.url}/healthz`)).ok).toBe(true);
		await server.stop();
	} finally {
		await occupied.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 10_000);

test("drains every registered resource and lets a failed cleanup retry without repeating successes", async () => {
	const cleanup = new BootCleanup();
	const calls: string[] = [];
	let fail = true;
	cleanup.add(() => {
		calls.push("database");
	});
	cleanup.add(() => {
		calls.push("runtime");
		if (fail) {
			fail = false;
			throw new Error("transient cleanup");
		}
	});
	cleanup.add(() => {
		calls.push("listener");
	});
	await expect(cleanup.stop()).rejects.toThrow("could not stop");
	expect(calls).toEqual(["listener", "runtime", "database"]);
	await cleanup.stop();
	expect(calls).toEqual(["listener", "runtime", "database", "runtime"]);
});
