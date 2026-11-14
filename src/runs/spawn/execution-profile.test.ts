import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeSandboxClient, setupRepos } from "./test-helpers.ts";

describe("execution profiles at dispatch", () => {
	let db: WarrenDb;
	let repos: Repos;
	let directory: string;
	let projectId: string;
	beforeEach(async () => {
		({ db, repos } = await setupRepos());
		directory = await mkdtemp(join(tmpdir(), "profile-dispatch-"));
		projectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/x/profiles",
				localPath: directory,
				defaultBranch: "main",
			})
		).id;
		await repos.projectSettings.compareAndSet(projectId, 0, {
			executionProfiles: {
				implementation: { runtime: "codex", model: "implementation-model" },
				review: { runtime: "codex", model: "review-model" },
			},
		});
	});
	afterEach(async () => {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	});

	test.each(["implementer", "reviewer", "rework"])(
		"uses the selected profile for %s while preserving review checks",
		async (role) => {
			await repos.agents.upsert({ name: role, renderedJson: makeAgentJson({ name: role }) });
			const { client } = makeSandboxClient();
			const create = client.create.bind(client);
			let gateCommand: string | undefined;
			client.create = (spec) => {
				gateCommand = spec.qualityGate?.command;
				return create(spec);
			};
			const result = await spawnRun({
				repos,
				runtimeProvider: client,
				projectId,
				agentName: role,
				prompt: "Do the approved work",
				baseCommit: "a".repeat(40),
				projectSpawn: async () => ({ exitCode: 0, stdout: "qualityGate: bun test\n", stderr: "" }),
			});
			expect(result.run.model).toBe(role === "reviewer" ? "review-model" : "implementation-model");
			expect(result.run.provider).toBe("openai");
			expect(
				(result.run.renderedAgentJson as { frontmatter: { runtime: string } }).frontmatter.runtime,
			).toBe("codex");
			if (role === "reviewer") expect(gateCommand).toBe("bun test");
		},
	);

	test("pins the supplied profile even after project defaults change", async () => {
		const { client } = makeSandboxClient();
		const result = await spawnRun({
			repos,
			runtimeProvider: client,
			projectId,
			agentName: "refactor-bot",
			prompt: "Approved plan",
			executionProfile: { runtime: "codex", model: "pinned-model" },
		});
		expect(result.run.model).toBe("pinned-model");
	});

	test("rejects a mismatched override before reserving any work", async () => {
		const { client, calls } = makeSandboxClient();
		await expect(
			spawnRun({
				repos,
				runtimeProvider: client,
				projectId,
				agentName: "refactor-bot",
				prompt: "Work",
				modelOverride: "claude-opus-4-7",
			}),
		).rejects.toThrow("incompatible");
		expect(calls).toHaveLength(0);
		expect(await repos.runs.listAll()).toHaveLength(0);
	});
});
