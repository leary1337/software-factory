import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { createGitFixture } from "../workspace/git/test-fixture.ts";
import {
	assertProjectReady,
	checkProjectReadiness,
	getProjectReadiness,
	type ReadinessDeps,
} from "./readiness.ts";
import { proposeProjectSetup } from "./setup-pr.ts";

let db: WarrenDb;
let repos: Repos;
let fixture: Awaited<ReturnType<typeof createGitFixture>>;
let deps: ReadinessDeps;
let id: string;
let forge: FakeForge;
const workflow = `run-name: Factory deploy \${{ inputs.factory_sha }}\nenv:\n  FACTORY_RELEASE_SHA: \${{ inputs.factory_sha }}\non:\n  workflow_dispatch:\n    inputs:\n      factory_sha:\n        required: true\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ inputs.factory_sha }}\n      - run: |\n          export GITHUB_SHA="$FACTORY_RELEASE_SHA"\n          ./deploy/release.sh\n`;
beforeEach(async () => {
	db = await openDatabase({ path: ":memory:" });
	repos = createRepos(db);
	fixture = await createGitFixture({ prefix: "readiness-test-", initCommit: "source" });
	await mkdir(join(fixture.path, ".warren"));
	await mkdir(join(fixture.path, ".github/workflows"), { recursive: true });
	await writeFile(join(fixture.path, ".github/workflows/deploy.yml"), workflow);
	await writeFile(
		join(fixture.path, ".warren/config.yaml"),
		"qualityGate: test -f ready.txt\npreparation:\n  recipe: command\n  command: touch ready.txt\npr:\n  autoMerge:\n    method: merge\ndeploy:\n  autoDeploy: true\n  shaInput: factory_sha\n  smokeUrl: https://app.test/health\n  verification:\n    versionUrl: https://app.test/version\n    scenarioUrl: https://app.test/scenario\n    expectedText: works\n",
	);
	await fixture.git(["add", "."]);
	await fixture.git(["commit", "-qm", "project settings"]);
	const remote = join(fixture.root, "remote.git");
	await fixture.git(["init", "--bare", remote]);
	await fixture.git(["remote", "add", "origin", remote]);
	await fixture.git(["push", "origin", "main"]);
	id = (
		await repos.projects.create({
			gitUrl: `file://${remote}`,
			localPath: fixture.path,
			defaultBranch: "main",
		})
	).id;
	const deploys: ForgeDeploys = {
		resolveCommit: async () => ({ ok: true, value: "a".repeat(40) }),
		readWorkflow: async () => ({ ok: true, value: workflow }),
		listRuns: async () => ({ ok: true, value: [] }),
		listDeployments: async () => ({ ok: true, value: [] }),
		compare: async () => ({ ok: true, value: { aheadBy: 0, commits: [] } }),
		dispatch: async () => ({ ok: true, value: undefined }),
	};
	forge = Object.assign(new FakeForge(), {
		parseRepoRef: () => ({ forge: "fake", key: "owner/project" }) as RepoRef,
		deploys,
		readMergeProtection: async () => ({
			ok: true as const,
			value: {
				baseCommit: (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(),
				requiresUpToDate: true,
			},
		}),
	});
	forge.setAutoMergeArmCapability(true);
	deps = { repos, forge, directory: join(fixture.root, "readiness"), runtimeReady: async () => {} };
});
afterEach(async () => {
	await db.close();
	await fixture.cleanup();
});
describe.skipIf(process.platform !== "darwin")("project readiness", () => {
	test("checks a clean copy and invalidates proof after settings or source changes", async () => {
		await expect(assertProjectReady(deps, id)).rejects.toThrow("not ready");
		const result = await checkProjectReadiness(deps, id);
		expect(result.checks).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "checks", ok: true })]),
		);
		expect(result.ready).toBe(true);
		expect(await Bun.file(join(fixture.path, "ready.txt")).exists()).toBe(false);
		expect((await assertProjectReady(deps, id)).commit).toBe(result.commit ?? "");
		await repos.projectSettings.compareAndSet(id, 0, { qualityGate: "exit 7" });
		expect((await getProjectReadiness(deps, id)).stale).toBe(true);
		await expect(assertProjectReady(deps, id)).rejects.toThrow("not ready");
		expect((await checkProjectReadiness(deps, id)).ready).toBe(false);
	});
	test("blocks configured merge policies when the forge cannot prove enforcement", async () => {
		forge.setAutoMergeArmCapability(false);
		const result = await checkProjectReadiness(deps, id);
		expect(result.ready).toBe(false);
		expect(result.checks.find((check) => check.name === "merge")?.ok).toBe(false);
	});
	test("does not declare a new project ready without delivery or a passing check", async () => {
		await repos.projectSettings.compareAndSet(id, 0, { deploy: { autoDeploy: false } });
		const result = await checkProjectReadiness(deps, id);
		expect(result.ready).toBe(false);
		expect(result.checks.find((c) => c.name === "delivery")?.ok).toBe(false);
	});
	test("bases setup on current remote default branch despite stale tracking and a run checkout", async () => {
		const oldMain = (await fixture.git(["rev-parse", "origin/main"])).stdout.trim();
		await writeFile(join(fixture.path, "remote-only.txt"), "latest main");
		await fixture.git(["add", "remote-only.txt"]);
		await fixture.git(["commit", "-qm", "advance remote default branch"]);
		await fixture.git(["push", "origin", "main"]);
		const remoteMain = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
		await fixture.git(["update-ref", "refs/remotes/origin/main", oldMain]);
		await fixture.git(["checkout", "-b", "old-agent-run", oldMain]);
		await writeFile(join(fixture.path, "run-only.txt"), "unrelated agent work");
		await fixture.git(["add", "run-only.txt"]);
		await fixture.git(["commit", "-qm", "old run work"]);
		const ownerHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
		await repos.projectSettings.compareAndSet(id, 0, {
			preparation: { recipe: "command", command: "touch ready.txt; echo configured" },
		});
		const proposal = await proposeProjectSetup(deps, id);
		await fixture.git(["fetch", "origin", proposal.branch]);
		expect((await fixture.git(["rev-parse", "FETCH_HEAD^"])).stdout.trim()).toBe(remoteMain);
		expect((await fixture.git(["show", "FETCH_HEAD:remote-only.txt"])).stdout).toBe("latest main");
		expect(
			(await fixture.git(["ls-tree", "--name-only", "FETCH_HEAD", "run-only.txt"])).stdout,
		).toBe("");
		expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(ownerHead);
		expect((await fixture.git(["status", "--porcelain"])).stdout).toBe("");
	});
	test("proposes one setup PR without changing manifests or the owner checkout", async () => {
		await repos.projectSettings.compareAndSet(id, 0, {
			preparation: { recipe: "command", command: "touch ready.txt; echo configured" },
		});
		const before = (await fixture.git(["rev-parse", "HEAD"])).stdout;
		const first = await proposeProjectSetup(deps, id);
		const again = await proposeProjectSetup(deps, id);
		expect(first.url).toBeTruthy();
		expect(again.url).toBe(first.url);
		expect(again.changed).toBe(false);
		expect((await fixture.git(["rev-parse", "HEAD"])).stdout).toBe(before);
		expect((await fixture.git(["status", "--porcelain"])).stdout).toBe("");
	});
});
