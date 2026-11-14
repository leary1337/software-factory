import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";

import {
	type CoordinatorDeploymentFn,
	createDeploymentGate,
	type DeploymentInput,
} from "./deployment-gate.ts";

const SHA = "a".repeat(40);
const NOW = new Date("2026-11-10T20:00:00.000Z");

describe("approved release delivery", () => {
	let db: WarrenDb;
	let repos: Repos;
	let directory: string;
	let input: DeploymentInput;
	let deploys: ForgeDeploys;
	let gate: CoordinatorDeploymentFn;
	let dispatches: number;
	let smokeStatus: number;
	let forge: FakeForge;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		directory = await mkdtemp(join(tmpdir(), "factory-delivery-"));
		await mkdir(join(directory, ".warren"));
		await mkdir(join(directory, ".github/workflows"), { recursive: true });
		await writeFile(join(directory, ".github/workflows/deploy.yml"), "name: Deploy\n");
		await writeFile(
			join(directory, ".warren/config.yaml"),
			"deploy:\n  autoDeploy: true\n  shaInput: factory_sha\n  smokeUrl: https://example.test/health\n",
		);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/o/r",
			localPath: directory,
			defaultBranch: "main",
		});
		const created = await repos.planRuns.create({
			projectId: project.id,
			planId: "pl-deploy",
			agentName: "implementer",
			children: [
				{ seq: 1, seedId: "s-1" },
				{ seq: 2, seedId: "s-2" },
			],
		});
		const planRun = await repos.planRuns.transitionTo(created.planRun.id, "running");
		const run = await repos.runs.create({
			projectId: project.id,
			agentName: "implementer",
			prompt: "build",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.runs.setPrUrl(run.id, "https://github.com/o/r/pull/1");
		await repos.runs.markRunning(run.id);
		await repos.runs.finalize(run.id, "succeeded");
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { runId: run.id, state: "dispatched" },
		});
		const child = await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { runId: run.id, state: "pr_open" },
		});
		input = {
			planRun,
			child,
			run: await repos.runs.require(run.id),
			prUrl: "https://github.com/o/r/pull/1",
			now: () => NOW,
			emit: async (runId, kind, payload) => {
				await repos.events.append({
					runId,
					kind,
					payload,
					ts: NOW.toISOString(),
					sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
				});
			},
		};
		dispatches = 0;
		smokeStatus = 200;
		deploys = {
			resolveCommit: async () => ({ ok: true, value: "a".repeat(40) }),
			readWorkflow: async () => ({
				ok: true,
				value: `run-name: Factory deploy \${{ inputs.factory_sha }}\non:\n  workflow_dispatch:\n    inputs:\n      factory_sha:\n        required: true\njobs:\n  deploy:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ inputs.factory_sha }}\n`,
			}),
			listDeployments: async () => ({
				ok: true,
				value: [{ sha: SHA, createdAt: NOW.toISOString(), state: "success" }],
			}),
			compare: async () => ({ ok: true, value: { aheadBy: 0, commits: [] } }),
			listRuns: async () => ({
				ok: true,
				value:
					dispatches > 0
						? [
								{
									id: 1,
									status: "completed",
									conclusion: "success",
									sha: SHA,
									displayTitle: `Factory deploy ${SHA}`,
									createdAt: NOW.toISOString(),
									url: "https://example.test/run/1",
								},
							]
						: [],
			}),
			dispatch: async () => {
				dispatches++;
				return { ok: true, value: undefined };
			},
		};
		forge = Object.assign(new FakeForge(), {
			deploys,
			parseRepoRef: () => ({ forge: "github", key: "o/r" }) as RepoRef,
			getPullRequest: async () => ({
				ok: true as const,
				value: {
					lifecycle: "merged" as const,
					mergedAt: NOW.getTime(),
					headCommit: "b".repeat(40),
					mergedCommit: SHA,
					baseBranch: "main",
					autoMerge: "unarmed" as const,
				},
			}),
		});
		gate = createDeploymentGate({
			repos,
			forge,
			fetch: (async () => {
				return new Response("ok", { status: smokeStatus });
			}) as unknown as unknown as typeof fetch,
		});
	});
	afterEach(async () => {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	});

	const verification = {
		versionUrl: "https://example.test/version",
		scenarioUrl: "https://example.test/scenario",
		expectedText: "works",
	};
	async function approve(boundary = false, artifactName?: string) {
		await repos.planApprovals.save({
			id: "approval",
			commandKey: "release-test",
			digest: "frozen",
			revision: 1,
			supersedesId: null,
			planRunId: input.planRun.id,
			decision: "approved",
			createdAt: NOW.toISOString(),
			snapshot: {
				version: 1,
				taskSource: "internal",
				projectId: input.planRun.projectId,
				title: "Release plan",
				profiles: {
					implementation: { runtime: "codex", model: "test" },
					review: { runtime: "codex", model: "test" },
				},
				toolkitVersion: "bundle",
				agents: {},
				budgets: { repairs: 2, reworks: 3, runMs: 1000, activeMs: 10000, externalWaitMs: 10000 },
				permissions: [],
				baseBranch: "main",
				agentName: "implementer",
				tasks: [1, 2].map((seq) => ({
					seq,
					id: `s-${seq}`,
					title: `Task ${seq}`,
					description: "Approved task",
					acceptance: ["works"],
					dependsOn: [],
					releaseAfter: seq === 2 || boundary,
					permissions: [],
					initialStatus: "open",
				})),
				settings: {
					deploy: {
						autoDeploy: true,
						shaInput: "factory_sha",
						smokeUrl: "https://example.test/health",
						verification: { ...verification, ...(artifactName ? { artifactName } : {}) },
						rollback: {
							workflow: "rollback.yml",
							shaInput: "factory_sha",
							compatibility: "application-only",
							reason: "No data migrations",
						},
					},
				},
			},
		});
		gate = createDeploymentGate({
			repos,
			forge,
			fetch: (async (url: string | URL | Request) =>
				new Response(String(url).endsWith("version") ? SHA : "works")) as unknown as typeof fetch,
		});
	}
	test("holds merged tasks until the final boundary and uses frozen settings", async () => {
		await approve();
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(dispatches).toBe(0);
		expect(
			(await repos.events.listByRun(input.run.id)).some(
				(e) => e.kind === "plan_run.release_pending",
			),
		).toBe(true);
		await writeFile(join(directory, ".warren/config.yaml"), "deploy:\n  autoDeploy: false\n");
		const child = (await repos.planRuns.listChildren(input.planRun.id)).find(
			(child) => child.seq === 2,
		);
		if (!child) throw new Error("Missing task");
		input = { ...input, child };
		expect(await gate(input)).toEqual({ kind: "waiting" });
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(dispatches).toBe(1);
	});
	test("publishes an explicit stage boundary only once", async () => {
		await approve(true);
		expect(await gate(input)).toEqual({ kind: "waiting" });
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(dispatches).toBe(1);
	});
	test("rejects application failure despite successful forge workflow", async () => {
		await approve(true);
		gate = createDeploymentGate({
			repos,
			forge,
			fetch: (async () => new Response("wrong")) as unknown as typeof fetch,
		});
		await gate(input);
		const result = await gate(input);
		expect(result.kind).toBe("incident");
		expect(result).toMatchObject({ reason: expect.stringContaining("No previously verified") });
		expect(
			(await repos.events.listByRun(input.run.id)).some(
				(e) => e.kind === "plan_run.deployment_verified",
			),
		).toBe(false);
	});
	test("freezes a verified onboarding workflow anchor and reuses it after restart", async () => {
		await approve(true, "proof");
		const previousSha = "b".repeat(40);
		const before = new Date(NOW.getTime() - 60000).toISOString();
		let rollback = false;
		let completed = false;
		let baselineReads = 0;
		const row = (id: number, release: string, createdAt: string) => ({
			id,
			status: "completed",
			conclusion: "success",
			sha: "c".repeat(40),
			displayTitle: `Factory deploy ${release}`,
			createdAt,
			url: `https://example.test/${id}`,
		});
		deploys.listRuns = async (_ref, workflow) => {
			if (workflow === "rollback.yml") {
				const restored = {
					...row(3, previousSha, NOW.toISOString()),
					status: completed ? "completed" : "in_progress",
				};
				return { ok: true, value: rollback ? [restored] : [] };
			}
			const runs = [row(7, previousSha, before)];
			if (dispatches) runs.push(row(1, SHA, NOW.toISOString()));
			return { ok: true, value: runs };
		};
		deploys.dispatch = async (_ref, workflow) => {
			dispatches++;
			if (workflow === "rollback.yml") rollback = true;
			return { ok: true, value: undefined };
		};
		deploys.readVerificationArtifact = async (_ref, id) => {
			if (id === 7 && ++baselineReads > 1)
				throw new Error("Historical proof is no longer accessible");
			return {
				ok: true,
				value: {
					schemaVersion: 1,
					sha: previousSha,
					workflowRunId: id,
					checkedAt: id === 7 ? before : NOW.toISOString(),
					readOnly: true,
					platform: { sha: previousSha },
					health: { url: "https://example.test/health", status: 200 },
					version: { url: verification.versionUrl, sha: previousSha },
					scenario: {
						url: verification.scenarioUrl,
						expectedText: verification.expectedText,
						passed: true,
					},
				},
			};
		};
		expect(await gate(input)).toEqual({ kind: "waiting" });
		expect(await gate(input)).toEqual({ kind: "waiting" });
		const saved = (await repos.events.listByRun(input.run.id)).find(
			(event) => event.kind === "plan_run.rollback_attempt",
		);
		expect(saved?.payloadJson).toMatchObject({
			expectedSha: previousSha,
			anchor: {
				workflowRunId: 7,
				checkedAt: before,
				workflow: "deploy.yml",
				artifactName: "proof",
			},
		});
		gate = createDeploymentGate({ repos, forge });
		completed = true;
		expect(await gate(input)).toMatchObject({ kind: "repair", restoredSha: previousSha });
		expect(baselineReads).toBe(1);
		expect(dispatches).toBe(2);
		expect(
			(await repos.events.listByRun(input.run.id)).some(
				(event) => event.kind === "plan_run.deployment_verified",
			),
		).toBe(false);
	});
	async function seedPrevious() {
		const previous = await repos.runs.create({
			projectId: input.planRun.projectId,
			agentName: "implementer",
			prompt: "previous",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await input.emit(previous.id, "plan_run.deployment_verified", {
			expectedSha: "b".repeat(40),
			environment: "production",
			verification: { availability: true, version: true, scenario: true },
			verificationPolicy: verification,
			smokeUrl: "https://example.test/health",
			smokeTimeoutMs: 1000,
		});
	}
	test("rolls back once, verifies the restored application and requests a normal repair", async () => {
		await approve(true);
		await seedPrevious();
		let rollback = false;
		const originalDispatch = deploys.dispatch;
		deploys.dispatch = async (ref, workflow, branch, inputs) => {
			if (workflow === "rollback.yml") rollback = true;
			return originalDispatch(ref, workflow, branch, inputs);
		};
		deploys.listRuns = async (_ref, workflow) => {
			const visible = workflow === "rollback.yml" ? rollback : dispatches > 0;
			if (!visible) return { ok: true, value: [] };
			return {
				ok: true,
				value: [
					{
						id: workflow === "rollback.yml" ? 2 : 1,
						status: "completed",
						conclusion: "success",
						sha: rollback ? "b".repeat(40) : SHA,
						displayTitle: `Factory deploy ${rollback ? "b".repeat(40) : SHA}`,
						createdAt: NOW.toISOString(),
						url: "https://example.test/run",
					},
				],
			};
		};
		deploys.listDeployments = async () => ({
			ok: true,
			value: [
				{ sha: rollback ? "b".repeat(40) : SHA, createdAt: NOW.toISOString(), state: "success" },
			],
		});
		gate = createDeploymentGate({
			repos,
			forge,
			fetch: (async (url: string | URL | Request) =>
				new Response(
					String(url).endsWith("version")
						? rollback
							? "b".repeat(40)
							: SHA
						: rollback
							? "works"
							: "broken",
				)) as unknown as typeof fetch,
		});
		expect(await gate(input)).toEqual({ kind: "waiting" });
		expect(await gate(input)).toMatchObject({ kind: "repair", restoredSha: "b".repeat(40) });
		expect(await gate(input)).toMatchObject({ kind: "repair" });
		expect(dispatches).toBe(2);
		const events = await repos.events.listByRun(input.run.id);
		expect(events.filter((e) => e.kind === "plan_run.rollback_verified")).toHaveLength(1);
		expect(events.some((e) => e.kind === "plan_run.deployment_verified")).toBe(false);
	});
	test("stops after failed restoration without repeating rollback", async () => {
		await approve(true);
		await seedPrevious();
		let rollback = false;
		deploys.dispatch = async (_ref, workflow) => {
			dispatches++;
			if (workflow === "rollback.yml") rollback = true;
			return { ok: true, value: undefined };
		};
		deploys.listRuns = async (_ref, workflow) => {
			const visible = workflow === "rollback.yml" ? rollback : dispatches > 0;
			if (!visible) return { ok: true, value: [] };
			return {
				ok: true,
				value: [
					{
						id: workflow === "rollback.yml" ? 2 : 1,
						status: "completed",
						conclusion: workflow === "rollback.yml" ? "failure" : "success",
						sha: SHA,
						displayTitle: `Factory deploy ${workflow === "rollback.yml" ? "b".repeat(40) : SHA}`,
						createdAt: NOW.toISOString(),
						url: "https://example.test/run",
					},
				],
			};
		};
		gate = createDeploymentGate({
			repos,
			forge,
			fetch: (async () => new Response("broken")) as unknown as typeof fetch,
		});
		await gate(input);
		expect(await gate(input)).toMatchObject({
			kind: "incident",
			reason: expect.stringContaining("Rollback workflow failed"),
		});
		expect(await gate(input)).toMatchObject({ kind: "incident" });
		expect(dispatches).toBe(2);
	});
});
