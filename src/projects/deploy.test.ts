import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import type { DeployRecord, ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import {
	getProjectDeployOverview,
	loadDeploymentHistory,
	type ProjectDeployDeps,
	startProjectDeploy,
} from "./deploy.ts";

const ref = { forge: "github", key: "o/r" } as RepoRef;
const failed = { sha: "bad", createdAt: "2026-11-10", state: "failure" } as const;
const live = { sha: "live", createdAt: "2026-11-09", state: "success" } as const;
function fakeDeploys(records: readonly DeployRecord[] = []): ForgeDeploys {
	return {
		resolveCommit: async () => ({ ok: true, value: "a".repeat(40) }),
		readWorkflow: async () => ({
			ok: true,
			value: "",
		}),
		listDeployments: async (_ref, _env, limit, page = 1) => ({
			ok: true,
			value: records.slice((page - 1) * limit, page * limit),
		}),
		listRuns: async () => ({ ok: true, value: [] }),
		compare: async () => ({
			ok: true,
			value: {
				aheadBy: 2,
				commits: [
					{ sha: "book", title: "seeds: sync" },
					{ sha: "feature", title: "Add feature" },
				],
			},
		}),
		dispatch: async () => ({ ok: true, value: undefined }),
	};
}

describe("loadDeploymentHistory", () => {
	test("finds the live release across pages while keeping only five history entries", async () => {
		const result = await loadDeploymentHistory(
			fakeDeploys([...Array.from({ length: 25 }, () => failed), live]),
			ref,
			"production",
		);
		expect(result).toEqual({
			ok: true,
			value: {
				history: Array.from({ length: 5 }, () => failed),
				current: live,
				currentState: "deployed",
			},
		});
	});
	test("distinguishes exhausted history from bounded or unknown history", async () => {
		for (const [records, currentState] of [
			[[], "none"],
			[[{ ...live, state: "inactive" }], "none"],
			[[{ ...failed, state: "unknown" }], "unknown"],
			[Array.from({ length: 200 }, () => failed), "unknown"],
		] as const) {
			const result = await loadDeploymentHistory(fakeDeploys(records), ref, "production");
			expect(result.ok && result.value.currentState).toBe(currentState);
		}
	});
	test("does not claim an older success is current when a newer status is unknown", async () => {
		const result = await loadDeploymentHistory(
			fakeDeploys([{ ...failed, state: "unknown" }, live]),
			ref,
			"production",
		);
		expect(result.ok && result.value.currentState).toBe("unknown");
	});
	test("propagates a later page failure rather than claiming no release", async () => {
		const deploys = fakeDeploys();
		deploys.listDeployments = async (_ref, _env, _limit, page) =>
			page === 1
				? { ok: true, value: Array.from({ length: 20 }, () => failed) }
				: { ok: false, error: { kind: "network", detail: "network unavailable" } };
		expect((await loadDeploymentHistory(deploys, ref, "production")).ok).toBe(false);
	});
});

describe("project deployment", () => {
	let db: WarrenDb;
	let directory: string;
	let projectId: string;
	let deps: ProjectDeployDeps;
	let deploys: ForgeDeploys;
	let dispatches: number;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		directory = await mkdtemp(join(tmpdir(), "factory-deploy-"));
		await mkdir(join(directory, ".github/workflows"), { recursive: true });
		await writeFile(join(directory, ".github/workflows/deploy.yml"), "name: Deploy\n");
		projectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/o/r",
				localPath: directory,
				defaultBranch: "master",
			})
		).id;
		deploys = fakeDeploys([...Array.from({ length: 5 }, () => failed), live]);
		dispatches = 0;
		deploys.dispatch = async () => {
			dispatches++;
			return { ok: true, value: undefined };
		};
		deps = { repos, forge: Object.assign(new FakeForge(), { deploys, parseRepoRef: () => ref }) };
	});
	afterEach(async () => {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	});
	test("compares the sixth successful release and filters bookkeeping changes", async () => {
		const result = await getProjectDeployOverview(deps, projectId);
		expect(result.configured && result.current?.sha).toBe("live");
		expect(result.configured && result.behind).toEqual({
			count: 2,
			changes: [{ sha: "feature", title: "Add feature" }],
		});
	});
	test("rejects dispatch when active workflow lookup fails", async () => {
		deploys.listRuns = async () => ({
			ok: false,
			error: { kind: "unauthorized", detail: "denied" },
		});
		await expect(startProjectDeploy(deps, projectId)).rejects.toThrow(
			"Cannot check active deployments",
		);
		expect(dispatches).toBe(0);
	});
	test("rejects dispatch when a workflow is already active", async () => {
		deploys.listRuns = async () => ({
			ok: true,
			value: [
				{
					id: 1,
					status: "queued",
					conclusion: null,
					sha: "a",
					createdAt: "today",
					url: "https://example.test",
				},
			],
		});
		await expect(startProjectDeploy(deps, projectId)).rejects.toThrow("already running");
		expect(dispatches).toBe(0);
	});
	test("reports lookup errors as unknown and retries rather than caching them", async () => {
		deploys.listDeployments = async () => ({
			ok: false,
			error: { kind: "unauthorized", detail: "denied" },
		});
		const result = await getProjectDeployOverview(deps, projectId);
		expect(result.configured && result.currentState).toBe("unknown");
		expect(result.configured && result.error).toContain("token needs");
		deploys.listDeployments = fakeDeploys([live]).listDeployments;
		const retried = await getProjectDeployOverview(deps, projectId);
		expect(retried.configured && retried.currentState).toBe("deployed");
	});
	test("dispatches the project branch and invalidates cached history", async () => {
		await getProjectDeployOverview(deps, projectId);
		expect(await startProjectDeploy(deps, projectId)).toEqual({
			dispatched: true,
			branch: "master",
		});
		expect(dispatches).toBe(1);
		deploys.listDeployments = fakeDeploys([]).listDeployments;
		const result = await getProjectDeployOverview(deps, projectId);
		expect(result.configured && result.currentState).toBe("none");
	});
	test("allows only one concurrent dispatch for a project", async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		deploys.listRuns = async () => {
			await pending;
			return { ok: true, value: [] };
		};
		const first = startProjectDeploy(deps, projectId);
		const second = startProjectDeploy(deps, projectId);
		release?.();
		await first;
		await expect(second).rejects.toThrow("previous deployment request");
		expect(dispatches).toBe(1);
	});

	test("rejects missing project and reports absent workflows", async () => {
		await expect(getProjectDeployOverview(deps, "absent")).rejects.toThrow();
		await rm(join(directory, ".github/workflows/deploy.yml"));
		expect(await getProjectDeployOverview(deps, projectId)).toEqual({ configured: false });
		await expect(startProjectDeploy(deps, projectId)).rejects.toThrow("no deploy workflow");
	});
});
