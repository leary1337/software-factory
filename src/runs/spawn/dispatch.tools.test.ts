import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeAgentJson, makeProvider, makeSandboxClient, setupRepos } from "./test-helpers.ts";

describe("spawnRun: per-agent tool policy (warren-8dee)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});

	afterEach(async () => {
		await db.close();
	});

	test("forwards frontmatter.tools as burrow run metadata to the runtime adapter", async () => {
		await repos.agents.upsert({
			name: "codex",
			renderedJson: makeAgentJson({
				name: "codex",
				frontmatter: {
					source: "builtin",
					tools: { allow: ["read", "grep"], deny: ["write"], noBuiltins: true },
				},
			}),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "codex",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});

		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
		expect(dispatch).toBeDefined();
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		expect(body.metadata.frontmatter.tools).toEqual({
			allow: ["read", "grep"],
			deny: ["write"],
			noBuiltins: true,
		});
	});

	test("omits frontmatter.tools when the agent declares no policy", async () => {
		await repos.agents.upsert({
			name: "codex",
			renderedJson: makeAgentJson({ name: "codex", frontmatter: { source: "builtin" } }),
		});
		const { client, calls } = makeSandboxClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "codex",
			projectId: "prj_xxxxxxxxxxxx",
			prompt: "p",
		});

		const dispatch = calls.find((c) => c.path === "/sandboxes/bur_aaaaaaaaaaaa/runs");
		const body = dispatch?.body as { metadata: { frontmatter: Record<string, unknown> } };
		expect(body.metadata.frontmatter.tools).toBeUndefined();
	});
});
