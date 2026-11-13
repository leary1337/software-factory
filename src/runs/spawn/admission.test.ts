import { afterEach, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import { spawnRun } from "./index.ts";
import { makeSandboxClient, setupRepos } from "./test-helpers.ts";

const databases: WarrenDb[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) await db.close();
});

test("admits only one concurrent manual or automatic request across projects", async () => {
	const { db, repos } = await setupRepos();
	databases.push(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/a/b",
		localPath: "/tmp/b",
		defaultBranch: "main",
	});
	const { client, calls } = makeSandboxClient();
	const spawn = (projectId: string, trigger: string) =>
		spawnRun({
			repos,
			runtimeProvider: client,
			projectId,
			agentName: "refactor-bot",
			prompt: "work",
			trigger,
			serverEnv: {},
		});
	const results = await Promise.allSettled([
		spawn("prj_xxxxxxxxxxxx", "manual"),
		spawn(project.id, "plan-run"),
	]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(await repos.runs.countNonTerminal()).toBe(1);
	expect(calls.filter((call) => call.path === "/sandboxes" && call.method === "POST")).toHaveLength(
		1,
	);
});

test("waits for durable association before contacting runtime and releases a failed reservation", async () => {
	const { db, repos } = await setupRepos();
	databases.push(db);
	const { client, calls } = makeSandboxClient();
	let createdId = "";
	await expect(
		spawnRun({
			repos,
			runtimeProvider: client,
			projectId: "prj_xxxxxxxxxxxx",
			agentName: "refactor-bot",
			prompt: "work",
			onRunRowCreated: async (id) => {
				createdId = id;
				await Promise.resolve();
				expect(calls).toHaveLength(0);
				throw new Error("association unavailable");
			},
		}),
	).rejects.toThrow("association unavailable");
	expect(calls).toHaveLength(0);
	expect((await repos.runs.require(createdId)).state).toBe("failed");
	expect(await repos.runs.countNonTerminal()).toBe(0);
});
