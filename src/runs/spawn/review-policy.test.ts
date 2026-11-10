import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectRow } from "../../db/schema.ts";
import { createGitFixture } from "../../workspace/git/test-fixture.ts";
import { spawnRun } from "./index.ts";
import { readReviewGate } from "./review-policy.ts";
import { makeAgentJson, makeSandboxClient, setupRepos } from "./test-helpers.ts";
import type { SpawnRunInput } from "./types.ts";

describe("readReviewGate", () => {
	test("rejects unreadable policy before publishing a queued review run", async () => {
		const fixture = await createGitFixture({
			prefix: "review-policy-failure-",
			initCommit: "initial",
		});
		const { db, repos } = await setupRepos();
		try {
			await repos.agents.upsert({
				name: "reviewer",
				renderedJson: makeAgentJson({ name: "reviewer" }),
			});
			await repos.projects.create({
				id: "prj_policyfailed",
				gitUrl: "https://github.com/x/policy.git",
				localPath: fixture.path,
				defaultBranch: "main",
			});
			const { client, calls } = makeSandboxClient();
			let published = false;
			await expect(
				spawnRun({
					repos,
					runtimeProvider: client,
					agentName: "reviewer",
					projectId: "prj_policyfailed",
					prompt: "Review this change",
					baseCommit: "a".repeat(40),
					projectSpawn: async () => ({ exitCode: 1, stdout: "", stderr: "unavailable" }),
					onRunRowCreated: async () => {
						published = true;
					},
				}),
			).rejects.toThrow("Cannot read approved review policy");
			expect(published).toBe(false);
			expect(await repos.runs.listAll()).toHaveLength(0);
			expect(calls).toHaveLength(0);
		} finally {
			await db.close();
			fixture.cleanup();
		}
	});
	test("reads approved target branch policy and ignores modified checkout policy", async () => {
		const fixture = await createGitFixture({ prefix: "review-policy-", initCommit: "initial" });
		try {
			await mkdir(join(fixture.path, ".warren"));
			const config = join(fixture.path, ".warren/config.yaml");
			await writeFile(
				config,
				"qualityGate: approved\nacceptance:\n  enforce: true\n  checks:\n    - id: login\n      command: test-login\n",
			);
			expect((await fixture.git(["add", "."])).exitCode).toBe(0);
			expect((await fixture.git(["commit", "-m", "policy"])).exitCode).toBe(0);
			expect((await fixture.git(["branch", "release"])).exitCode).toBe(0);
			await writeFile(config, "qualityGate: poisoned\n");
			const gate = await readReviewGate(
				{
					reviewBaseBranch: "release",
					baseCommit: "a".repeat(40),
					prompt: "## Acceptance criteria\n- [ ] [check: login] Sign in",
				} as SpawnRunInput,
				{ gitUrl: fixture.path, localPath: fixture.path, defaultBranch: "absent" } as ProjectRow,
			);
			expect(gate.command).toBe("approved");
			expect(gate.acceptance).toMatchObject({
				enforce: true,
				criteria: [{ criterion: "Sign in", checkId: "login" }],
				checks: [{ command: "test-login" }],
			});
		} finally {
			fixture.cleanup();
		}
	});
});
