import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import { BUILTIN_AGENTS } from "../registry/builtins/index.ts";
import { preparePlanApproval, startApprovedPlan } from "./approval.ts";

export async function approvedFixture() {
	const root = await mkdtemp(join(tmpdir(), "approved-plan-"));
	const previous = process.env.WARREN_DATA_DIR;
	process.env.WARREN_DATA_DIR = root;
	let db = await openDatabase({ path: join(root, "factory.db") });
	let repos = createRepos(db);
	await repos.projects.create({
		id: "project",
		gitUrl: "https://github.com/x/y.git",
		localPath: root,
		defaultBranch: "main",
	});
	for (const agent of BUILTIN_AGENTS)
		await repos.agents.upsert({ name: agent.name, renderedJson: agent });
	const approval = await preparePlanApproval(
		{ repos, publishToolkit: async () => ({ version: "bundle-1" }) },
		{
			commandKey: "prepare-1",
			projectId: "project",
			title: "Plan",
			tasks: [
				{ title: "One", description: "First task", acceptance: ["First check"] },
				{ title: "Two", description: "Second task", acceptance: ["Second check"] },
			],
		},
	);
	const { planRun } = await startApprovedPlan(repos, approval.id);
	return {
		root,
		approval,
		planRun,
		get repos() {
			return repos;
		},
		async reopen() {
			await db.close();
			db = await openDatabase({ path: join(root, "factory.db") });
			repos = createRepos(db);
		},
		async dispose() {
			await db.close();
			if (previous === undefined) delete process.env.WARREN_DATA_DIR;
			else process.env.WARREN_DATA_DIR = previous;
			await rm(root, { recursive: true, force: true });
		},
	};
}
