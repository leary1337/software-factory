import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { startProjectDeploy } from "../projects/deploy.ts";
import { FakeProvider } from "../runtime/fake/fake-provider.ts";
import { cancelPlanRun } from "./cancel.ts";
import { advancePlanRun } from "./coordinator.ts";
import {
	type CoordinatorDeploymentFn,
	createDeploymentGate,
	createProjectDeploymentBlocker,
	type DeploymentInput,
} from "./deployment-gate.ts";
import { resumePlanRun } from "./resume.ts";

const SHA = "a".repeat(40);
const NOW = new Date("2026-11-10T20:00:00.000Z");

describe("production delivery gate", () => {
	let db: WarrenDb;
	let repos: Repos;
	let directory: string;
	let input: DeploymentInput;
	let deploys: ForgeDeploys;
	let gate: CoordinatorDeploymentFn;
	let dispatches: number;
	let dispatchedInputs: Readonly<Record<string, string>> | undefined;
	let smokeCalls: number;
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
		dispatchedInputs = undefined;
		smokeCalls = 0;
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
			dispatch: async (_ref, _workflow, _branch, inputs) => {
				dispatchedInputs = inputs;
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
				smokeCalls++;
				return new Response("ok", { status: smokeStatus });
			}) as unknown as typeof fetch,
		});
	});
	afterEach(async () => {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	});
	test("leaves deployment off unless explicitly enabled", async () => {
		await writeFile(join(directory, ".warren/config.yaml"), "defaultRole: implementer\n");
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(dispatches).toBe(0);
	});
	test("dispatches once and verifies exact squash commit, workflow and smoke across repeated ticks", async () => {
		expect(await gate(input)).toEqual({ kind: "waiting" });
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(await gate(input)).toEqual({ kind: "passed" });
		expect(dispatches).toBe(1);
		expect(smokeCalls).toBe(1);
		expect(dispatchedInputs).toEqual({ factory_sha: SHA });
	});
	test("blocks manual delivery while automatic dispatch is not yet visible in GitHub", async () => {
		await gate(input);
		deploys.listRuns = async () => ({ ok: true, value: [] });
		await expect(startProjectDeploy({ repos, forge }, input.planRun.projectId)).rejects.toThrow(
			"Automatic production verification is unresolved",
		);
		expect(dispatches).toBe(1);
	});
	test("blocks automatic delivery after an unconfirmed manual dispatch", async () => {
		deploys.listRuns = async () => ({ ok: true, value: [] });
		await startProjectDeploy({ repos, forge }, input.planRun.projectId);
		expect((await gate(input)).kind).toBe("incident");
		expect(dispatches).toBe(1);
	});
	test("refuses an automatic workflow that does not pin checkout to the SHA input", async () => {
		deploys.readWorkflow = async () => ({ ok: true, value: "on: workflow_dispatch" });
		expect((await gate(input)).kind).toBe("incident");
		expect(dispatches).toBe(0);
	});

	test("does not dispatch again after interruption between intent and confirmation", async () => {
		deploys.dispatch = async () => {
			dispatches++;
			throw new Error("connection interrupted");
		};
		expect((await gate(input)).kind).toBe("incident");
		expect((await gate(input)).kind).toBe("incident");
		expect(dispatches).toBe(1);
	});
	test("rejects missing merge SHA before mutation", async () => {
		forge.getPullRequest = async () => ({
			ok: true,
			value: {
				lifecycle: "merged",
				mergedAt: NOW.getTime(),
				headCommit: SHA,
				baseBranch: "main",
				autoMerge: "unarmed",
			},
		});
		expect((await gate(input)).kind).toBe("incident");
		expect(dispatches).toBe(0);
	});
	test("rejects a successful workflow for a different commit", async () => {
		await gate(input);
		deploys.listRuns = async () => ({
			ok: true,
			value: [
				{
					id: 2,
					status: "completed",
					conclusion: "success",
					sha: "c".repeat(40),
					createdAt: NOW.toISOString(),
					url: "https://example.test/run/2",
				},
			],
		});
		expect((await gate(input)).kind).toBe("incident");
		expect(smokeCalls).toBe(0);
	});
	test("keeps waiting on transient polling failures until bounded deadline", async () => {
		await gate(input);
		deploys.listRuns = async () => ({ ok: false, error: { kind: "network", detail: "offline" } });
		expect((await gate(input)).kind).toBe("waiting");
		expect((await gate({ ...input, now: () => new Date(NOW.getTime() + 900_000) })).kind).toBe(
			"incident",
		);
	});
	test("keeps a pending deployment blocked across attempted cancellation", async () => {
		await gate(input);
		await expect(
			cancelPlanRun({ planRunId: input.planRun.id, repos, runtimeProvider: new FakeProvider() }),
		).rejects.toThrow("Production verification is pending");
		expect((await repos.planRuns.require(input.planRun.id)).state).toBe("running");
		// Even a historical/direct state change cannot erase durable verification intent.
		await repos.planRuns.transitionTo(input.planRun.id, "cancelled");
		const other = { ...input.planRun, id: "another-plan" };
		expect(await createProjectDeploymentBlocker({ repos })(other)).toContain("verification");
	});
	test("verifies readiness through a real bounded HTTP request", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests++;
				return new Response(
					request.headers.get("User-Agent") === "software-factory-smoke" ? "ready" : "wrong client",
					{ status: request.headers.get("User-Agent") === "software-factory-smoke" ? 200 : 400 },
				);
			},
		});
		try {
			await writeFile(
				join(directory, ".warren/config.yaml"),
				`deploy:\n  autoDeploy: true\n  shaInput: factory_sha\n  smokeUrl: http://127.0.0.1:${server.port}/health\n`,
			);
			const realGate = createDeploymentGate({ repos, forge });
			expect(await realGate(input)).toEqual({ kind: "waiting" });
			expect(await realGate(input)).toEqual({ kind: "passed" });
			expect(requests).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	test("fails the plan and blocks its next child on smoke failure, then explicitly resumes verification", async () => {
		smokeStatus = 503;
		let spawned = 0;
		const advance = () =>
			advancePlanRun({
				planRun: input.planRun,
				repos,
				getIssue: async () => ({ id: "s-2", title: "Next", description: "", status: "open" }),
				checkPrMerged: async () => ({ kind: "merged", mergedAt: NOW.toISOString() }),
				spawn: async () => {
					spawned++;
					return { runId: "next" };
				},
				emit: input.emit,
				verifyDeployment: gate,
				now: input.now,
			});
		expect((await advance()).kind).toBe("waiting_for_merge");
		expect((await advance()).kind).toBe("plan_failed");
		expect(spawned).toBe(0);
		expect((await repos.planRuns.require(input.planRun.id)).failureReason).toBe(
			"deployment_incident",
		);
		const blocked = createProjectDeploymentBlocker({ repos });
		expect(await blocked(input.planRun)).toContain("incident");
		smokeStatus = 200;
		const resumed = await resumePlanRun({
			planRunId: input.planRun.id,
			repos,
			emit: input.emit,
			now: () => new Date(NOW.getTime() + 1000),
		});
		expect(await gate({ ...input, planRun: resumed.planRun })).toEqual({ kind: "passed" });
		expect(dispatches).toBe(1);
		expect(await blocked(resumed.planRun)).toBeNull();
	});
});
