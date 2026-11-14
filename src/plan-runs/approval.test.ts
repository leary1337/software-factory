import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { BUILTIN_AGENTS } from "../registry/builtins/index.ts";
import { spawnRun } from "../runs/spawn/index.ts";
import { FakeProvider } from "../runtime/fake/fake-provider.ts";
import { preparePlanApproval, startApprovedPlan } from "./approval.ts";
import { approvedSpawnOptions } from "./approved-dispatch.ts";
import { advancePlanRun } from "./coordinator.ts";

let db: WarrenDb;
let repos: Repos;
let projectPath: string;
let previousDataRoot: string | undefined;
beforeEach(async () => {
	projectPath = await mkdtemp(join(tmpdir(), "approval-"));
	previousDataRoot = process.env.WARREN_DATA_DIR;
	process.env.WARREN_DATA_DIR = projectPath;
	db = await openDatabase({ path: ":memory:" });
	repos = createRepos(db);
	await repos.projects.create({
		id: "project",
		gitUrl: "https://github.com/x/y.git",
		localPath: projectPath,
		defaultBranch: "main",
	});
	for (const agent of BUILTIN_AGENTS)
		await repos.agents.upsert({ name: agent.name, renderedJson: agent });
});
afterEach(async () => {
	await db.close();
	if (previousDataRoot === undefined) delete process.env.WARREN_DATA_DIR;
	else process.env.WARREN_DATA_DIR = previousDataRoot;
	await rm(projectPath, { recursive: true, force: true });
});
const task = {
	title: "Implement",
	description: "Implement exactly this",
	acceptance: ["The gate passes"],
};
const request = {
	commandKey: "click-1",
	projectId: "project",
	title: "Approved work",
	tasks: [
		{ title: "Implement", description: "Implement exactly this", acceptance: ["The gate passes"] },
	],
};
function deps() {
	return { repos, publishToolkit: async () => ({ version: "bundle-1" }) };
}
describe("approved plan", () => {
	test("saves a reviewable immutable snapshot before dispatch", async () => {
		await repos.projectSettings.compareAndSet("project", 0, { memoryEnabled: true });
		const approval = await preparePlanApproval(deps(), request);
		expect(approval.planRunId).toBeNull();
		expect(await repos.planRuns.listActive()).toEqual([]);
		expect(approval.snapshot.settings.memoryEnabled).toBe(true);
		expect(approval.snapshot.tasks[0]?.releaseAfter).toBe(true);
		await repos.projectSettings.compareAndSet("project", 1, { memoryEnabled: false });
		const retry = await preparePlanApproval(
			{ ...deps(), publishToolkit: async () => ({ version: "bundle-2" }) },
			request,
		);
		expect(retry).toEqual(approval);
		await expect(
			preparePlanApproval(deps(), { ...request, title: "Changed secretly" }),
		).rejects.toThrow("command key");
	});
	test("creates exactly one queue execution for concurrent and repeated start commands", async () => {
		const approval = await preparePlanApproval(deps(), request);
		const [first, second] = await Promise.all([
			startApprovedPlan(repos, approval.id),
			startApprovedPlan(repos, approval.id),
		]);
		expect(first).toEqual(second);
		expect(await repos.planRuns.listActive()).toHaveLength(1);
		expect(
			(await repos.planApprovals.forRun(first.planRun.id))?.snapshot.tasks[0]?.description,
		).toBe("Implement exactly this");
	});
	test("dispatches frozen task, model, memory and agent after source settings change", async () => {
		await repos.projectSettings.compareAndSet("project", 0, {
			memoryEnabled: true,
			executionProfiles: {
				implementation: { runtime: "codex", model: "gpt-approved" },
				review: { runtime: "codex", model: "gpt-review" },
			},
		});
		const approval = await preparePlanApproval(deps(), request);
		await repos.projectSettings.compareAndSet("project", 1, {
			memoryEnabled: false,
			executionProfiles: {
				implementation: { runtime: "codex", model: "gpt-changed" },
				review: { runtime: "codex", model: "gpt-changed" },
			},
		});
		const originalAgent = await repos.agents.get("implementer");
		await repos.agents.upsert({
			name: "implementer",
			renderedJson: {
				...(originalAgent?.renderedJson as Record<string, unknown>),
				sections: { system: "CHANGED AFTER APPROVAL" },
			},
		});
		const started = await startApprovedPlan(repos, approval.id);
		const provider = new FakeProvider();
		const outcome = await advancePlanRun({
			repos,
			planRun: started.planRun,
			getIssue: async () => {
				throw new Error("Mutable tracker must not be read");
			},
			checkPrMerged: async () => ({ kind: "open" }),
			emit: async () => {},
			spawn: async ({ prompt }) => {
				const result = await spawnRun({
					repos,
					runtimeProvider: provider,
					agentName: "implementer",
					projectId: "project",
					prompt,
					...approvedSpawnOptions(approval, "implementer"),
				});
				return { runId: result.run.id };
			},
		});
		expect(outcome).toMatchObject({ kind: "dispatched" });
		const dispatched = provider.calls[1]?.body as {
			prompt: string;
			metadata: { frontmatter: Record<string, unknown> };
		};
		expect(dispatched.prompt).toContain("Implement exactly this");
		expect(dispatched.prompt).toContain("The gate passes");
		expect(dispatched.prompt).not.toContain("CHANGED AFTER APPROVAL");
		expect(dispatched.metadata.frontmatter).toMatchObject({
			model: "gpt-approved",
			mulch: "on",
			toolkitVersion: "bundle-1",
		});
	});

	test("rejects missing acceptance and forward dependencies before enqueueing", async () => {
		await expect(
			preparePlanApproval(deps(), {
				...request,
				tasks: [{ ...task, acceptance: [] }],
			}),
		).rejects.toThrow();
		await expect(
			preparePlanApproval(deps(), {
				...request,
				tasks: [{ ...task, dependsOn: [2] }],
			}),
		).rejects.toThrow("earlier");
		expect(await repos.planRuns.listActive()).toEqual([]);
	});
});
