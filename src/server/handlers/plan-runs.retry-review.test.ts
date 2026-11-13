import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { CoordinatorEmitFn } from "../../plan-runs/coordinator.ts";
import type { HandleInFlightInput } from "../../plan-runs/in-flight.ts";
import { advanceReview, loadReviewStage } from "../../plan-runs/review.ts";
import { bearerAuth, NO_AUTH, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";

describe("review recovery after dispatch failure", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle;
	let input: HandleInFlightInput;
	let runId: string;
	let url: string;
	let emit: CoordinatorEmitFn;
	const sha = "a".repeat(40);

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/o/r",
			localPath: "/tmp/r",
			defaultBranch: "main",
		});
		const created = await repos.planRuns.create({
			planId: "pl-retry",
			projectId: project.id,
			agentName: "implementer",
			children: [
				{ seq: 1, seedId: "task-1" },
				{ seq: 2, seedId: "task-2" },
			],
		});
		const planRun = await repos.planRuns.transitionTo(created.planRun.id, "running");
		const run = await repos.runs.create({
			agentName: "implementer",
			projectId: project.id,
			prompt: "implement",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		runId = run.id;
		await repos.runs.setBranch(run.id, "factory/task");
		await repos.runs.setPrUrl(run.id, "https://github.com/o/r/pull/1");
		await repos.runs.markRunning(run.id);
		await repos.runs.finalize(run.id, "succeeded");
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { state: "dispatched", runId },
		});
		const child = await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { state: "pr_open" },
		});
		emit = async (id, kind, payload) => {
			await repos.events.append({
				runId: id,
				kind,
				payload,
				stream: "system",
				ts: new Date().toISOString(),
				sandboxEventSeq: ((await repos.events.maxSeqForRun(id)) ?? 0) + 1,
			});
		};
		input = {
			planRun,
			child,
			repos,
			emit,
			getReviewHead: async () => sha,
			getIssue: async () => ({
				id: "task-1",
				status: "open",
				title: "Work",
				description: "Acceptance",
			}),
			spawn: async () => {
				throw new Error("Approved base branch must configure a quality gate.");
			},
			checkPrMerged: async () => ({ kind: "open" }),
			now: () => new Date(),
			mergeTimeoutMs: 0,
			mergeStallWarningMs: 0,
		};
		await advanceReview(input, await repos.runs.require(runId), "https://github.com/o/r/pull/1");
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		url = `${tcpUrl(handle)}/plan-runs/${planRun.id}/children/1/retry-review`;
	});

	afterEach(async () => {
		await handle?.stop();
		await db?.close();
	});

	test("retains the dispatch cause instead of a generic dead end", async () => {
		const events = await repos.events.listByRun(runId);
		const report = events.find((event) => event.kind === "plan_run.review_finished")?.payloadJson;
		expect(report).toMatchObject({
			outcome: "broken",
			report: expect.stringContaining("configure a quality gate"),
		});
	});

	test("retries on the same PR once, preserves history and never advances the next task", async () => {
		expect(await loadReviewStage(repos, "implementer", runId)).toBe("needs_attention");
		const responses = await Promise.all([
			fetch(url, { method: "POST" }),
			fetch(url, { method: "POST" }),
		]);
		for (const response of responses) expect(response.status).toBe(200);
		expect(await loadReviewStage(repos, "implementer", runId)).toBe("reviewing");
		const events = await repos.events.listByRun(runId);
		expect(events.filter((event) => event.kind === "plan_run.review_retry_requested")).toHaveLength(
			1,
		);
		expect(events.filter((event) => event.kind === "plan_run.review_finished")).toHaveLength(1);
		const spawns: unknown[] = [];
		const spawn: HandleInFlightInput["spawn"] = async (request) => {
			spawns.push(request);
			const review = await repos.runs.create({
				agentName: "reviewer",
				projectId: input.planRun.projectId,
				prompt: request.prompt,
				renderedAgentJson: {},
				trigger: "plan-run",
				baseCommit: request.baseCommit,
			});
			await request.onRunCreated?.(review.id);
			return { runId: review.id };
		};
		const run = await repos.runs.require(runId);
		await advanceReview({ ...input, spawn }, run, run.prUrl ?? "");
		await advanceReview({ ...input, spawn }, run, run.prUrl ?? "");
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toMatchObject({
			agentName: "reviewer",
			existingBranch: "factory/task",
			baseCommit: sha,
		});
		expect((await repos.planRuns.listChildren(input.planRun.id))[1]?.state).toBe("pending");
		expect((await fetch(url, { method: "POST" })).status).toBe(409);
	});

	test("rejects retry for an unrelated pending task or a cancelled plan", async () => {
		expect(
			(await fetch(url.replace("/children/1/", "/children/2/"), { method: "POST" })).status,
		).toBe(409);
		await repos.planRuns.transitionTo(input.planRun.id, "cancelled");
		expect((await fetch(url, { method: "POST" })).status).toBe(409);
	});

	test("recovers a failed reviewer without erasing earlier reworks or granting a merge", async () => {
		for (const agentName of ["rework", "reviewer"]) {
			const step = await repos.runs.create({
				agentName,
				projectId: input.planRun.projectId,
				prompt: "step",
				renderedAgentJson: {},
				trigger: "plan-run",
				baseCommit: sha,
			});
			await repos.runs.markRunning(step.id);
			await repos.runs.finalize(step.id, agentName === "rework" ? "succeeded" : "failed");
			await repos.runs.updateUsage(step.id, {
				tokensInput: 1,
				tokensOutput: 1,
				tokensCacheRead: 0,
				tokensCacheWrite: 0,
			});
			await emit(runId, "plan_run.review_step", {
				step: agentName === "rework" ? "rework" : "review",
				stepRunId: step.id,
				reviewedCommit: sha,
			});
		}
		const run = await repos.runs.require(runId);
		await advanceReview(input, run, run.prUrl ?? "");
		expect((await fetch(url, { method: "POST" })).status).toBe(200);
		const events = await repos.events.listByRun(runId);
		expect(events.filter((event) => event.kind === "plan_run.review_step")).toHaveLength(2);
		expect(await loadReviewStage(repos, "implementer", runId)).toBe("reviewing");
		await advanceReview(input, run, run.prUrl ?? ""); // dispatch is still failing
		expect(await loadReviewStage(repos, "implementer", runId)).toBe("needs_attention");
		expect((await repos.events.listByRun(runId)).at(-1)?.payloadJson).toMatchObject({
			outcome: "broken",
			report: expect.stringContaining("configure a quality gate"),
		});
		expect((await fetch(url, { method: "POST" })).status).toBe(200);
		expect((await repos.planRuns.listChildren(input.planRun.id))[0]?.state).toBe("pr_open");
	});

	test("rejects invalid task numbers and unknown plans", async () => {
		expect(
			(await fetch(url.replace("/children/1/", "/children/zero/"), { method: "POST" })).status,
		).toBe(400);
		expect(
			(await fetch(url.replace(input.planRun.id, "plnr_missing"), { method: "POST" })).status,
		).toBe(404);
	});

	test("withholds the failure from spectators and refuses their retry", async () => {
		await handle.stop();
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth("test-operator")),
			logger: silentLogger,
		});
		const base = `${tcpUrl(handle)}/plan-runs/${input.planRun.id}`;
		expect((await fetch(`${base}/children/1/retry-review`, { method: "POST" })).status).toBe(403);
		const spectator = (await (await fetch(base)).json()) as { children: Record<string, unknown>[] };
		expect(spectator.children[0]).not.toHaveProperty("reviewFailure");
		const operator = (await (
			await fetch(base, { headers: { Authorization: "Bearer test-operator" } })
		).json()) as { children: Record<string, unknown>[] };
		expect(operator.children[0]?.reviewFailure).toContain("configure a quality gate");
	});

	test("scrubs credentials before persisting a dispatch error", async () => {
		await fetch(url, { method: "POST" });
		const secret = `ghp_${"x".repeat(36)}`;
		await advanceReview(
			{
				...input,
				spawn: async () => {
					throw new Error(`Auth failed: ${secret}`);
				},
			},
			await repos.runs.require(runId),
			"https://github.com/o/r/pull/1",
		);
		const events = JSON.stringify(await repos.events.listByRun(runId));
		expect(events).not.toContain(secret);
		expect(events).toContain("[redacted]");
	});
});
