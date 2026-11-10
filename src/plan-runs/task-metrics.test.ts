import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow } from "../db/schema.ts";
import { aggregateTaskMetrics } from "./task-metrics.ts";
import { loadTaskMetrics } from "./task-metrics-load.ts";

describe("loadTaskMetrics", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let child: PlanRunChildRow;
	const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11) + seconds * 1000);
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		projectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/test/tasks",
				localPath: "/tmp/tasks",
				defaultBranch: "main",
				hasSeeds: false,
			})
		).id;
		const plan = await repos.planRuns.create({
			projectId,
			agentName: "implementer",
			planId: "plan",
			children: [{ seq: 1, seedId: "task" }],
			now: at(0),
		});
		const first = plan.children[0];
		if (!first) throw new Error("missing test child");
		child = first;
	});
	afterEach(async () => {
		await db.close();
	});

	async function run(id: string, start: number, end: number | null = start + 10) {
		await repos.runs.create({
			id,
			projectId,
			agentName: "implementer",
			prompt: "task",
			renderedAgentJson: {},
			trigger: "plan-run",
			now: at(start),
			costBasis: "subscription_estimate",
		});
		await repos.runs.markRunning(id, at(start));
		if (end !== null) await repos.runs.finalize(id, "succeeded", at(end));
		await repos.runs.attachStats(id, {
			costUsd: 1.5,
			tokensInput: 100,
			tokensOutput: 20,
			tokensCacheRead: 30,
			tokensCacheWrite: 0,
		});
		return id;
	}

	async function event(runId: string, kind: string, payload: Record<string, unknown> = {}) {
		return repos.events.append({
			runId,
			kind,
			payload,
			stream: "system",
			ts: at(100).toISOString(),
			sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
		});
	}

	test("joins retries, cold reviews and rework once and preserves observed interventions", async () => {
		await run("old", 0);
		child = {
			...child,
			runId: await run("impl", 20),
			state: "merged",
			endedAt: at(150).toISOString(),
		};
		for (const [id, start] of [
			["review", 40],
			["rework", 60],
			["ui", 80],
		] as const)
			await run(id, start);
		await event("impl", "plan_run.child_retried", { previousRunId: "old" });
		for (const [stepRunId, step] of [
			["review", "review"],
			["rework", "rework"],
			["ui", "ui_review"],
			["review", "review"],
		])
			await event("impl", "plan_run.review_step", { stepRunId, step });
		await event("old", "plan_run.child_retried", { previousRunId: "impl" });
		await event("review", "state_change", {
			type: "result",
			result: "VERDICT: CHANGES\nFix validation",
		});
		await event("impl", "plan_run.review_finished", { outcome: "passed" });
		await event("rework", "steer.sent");
		await event("impl", "plan_run.resumed");
		await event("impl", "plan_run.deployment_incident");
		for (let i = 0; i < 2; i++)
			await event("impl", "factory.learning", { trigger: "escalation", sourceKey: "same" });
		const metrics = await loadTaskMetrics(repos, projectId, child, at(200).getTime());
		expect(metrics).toMatchObject({
			runCount: 5,
			missingRunCount: 0,
			incomplete: false,
			costUsd: 7.5,
			costUnknownRuns: 0,
			subscriptionEstimateRuns: 5,
			totalTokens: 750,
			tokenUnknownRuns: 0,
			activeMs: 50_000,
			durationUnknownRuns: 0,
			elapsedMs: 150_000,
			deliveryMs: 150_000,
			reviewCount: 1,
			uiReviewCount: 1,
			reworkCount: 1,
			firstPass: false,
			steeringCount: 1,
			resumeCount: 1,
			escalationCount: 1,
			postMergeIncidentCount: 1,
		});
	});

	test("reports unknown usage without treating it as free and accounts for running time", async () => {
		child = { ...child, runId: await run("impl", 20, null), state: "running" };
		await repos.runs.attachStats("impl", { costUsd: null, tokensInput: null });
		expect(await loadTaskMetrics(repos, projectId, child, at(30).getTime())).toMatchObject({
			costUsd: null,
			costUnknownRuns: 1,
			totalTokens: null,
			tokenUnknownRuns: 1,
			activeMs: 10_000,
			durationUnknownRuns: 0,
			elapsedMs: 10_000,
			deliveryMs: null,
			firstPass: null,
		});
	});

	test("marks unavailable lineage incomplete and never imports another project's cost", async () => {
		child = { ...child, runId: await run("impl", 0) };
		const other = await repos.projects.create({
			gitUrl: "https://github.com/test/other",
			localPath: "/tmp/other",
			defaultBranch: "main",
			hasSeeds: false,
		});
		await repos.runs.create({
			id: "foreign",
			projectId: other.id,
			agentName: "reviewer",
			prompt: "private",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await event("impl", "plan_run.review_step", { stepRunId: "foreign", step: "review" });
		await event("impl", "plan_run.child_retried", { previousRunId: "deleted" });
		await event("impl", "plan_run.review_finished", { outcome: "passed" });
		expect(await loadTaskMetrics(repos, projectId, child)).toMatchObject({
			runCount: 1,
			missingRunCount: 2,
			incomplete: true,
			costUsd: 1.5,
			costUnknownRuns: 2,
			firstPass: null,
		});
	});

	test("distinguishes first pass from pending review and tasks that never ran", async () => {
		expect(await loadTaskMetrics(repos, projectId, child)).toMatchObject({
			runCount: 0,
			costUsd: null,
			totalTokens: null,
			activeMs: null,
			elapsedMs: null,
			firstPass: null,
		});
		child = { ...child, runId: await run("impl", 0) };
		await run("review", 20);
		await event("impl", "plan_run.review_step", { stepRunId: "review", step: "review" });
		expect((await loadTaskMetrics(repos, projectId, child)).firstPass).toBeNull();
		await event("impl", "plan_run.review_finished", { outcome: "passed" });
		expect((await loadTaskMetrics(repos, projectId, child)).firstPass).toBe(true);
		await run("second", 40);
		await event("impl", "plan_run.review_step", { stepRunId: "second", step: "review" });
		expect((await loadTaskMetrics(repos, projectId, child)).firstPass).toBe(false);
	});

	test("deduplicates run inputs and refuses negative or incomplete timing", async () => {
		await run("impl", 10);
		const entry = {
			run: { ...(await repos.runs.require("impl")), startedAt: at(40).toISOString() },
			events: [],
		};
		expect(
			aggregateTaskMetrics({ ...child, state: "merged", endedAt: null }, [entry, entry]),
		).toMatchObject({
			runCount: 1,
			activeMs: null,
			durationUnknownRuns: 1,
			elapsedMs: null,
			deliveryMs: null,
		});
	});

	test("keeps first-pass review success when merge protection blocks delivery", async () => {
		child = { ...child, runId: await run("impl", 0), state: "pr_open" };
		await run("review", 20);
		await event("impl", "plan_run.review_step", { stepRunId: "review", step: "review" });
		await event("impl", "plan_run.review_decided", { outcome: "passed" });
		await event("impl", "plan_run.review_finished", { outcome: "broken" });
		expect(await loadTaskMetrics(repos, projectId, child)).toMatchObject({
			firstPass: true,
			deliveryMs: null,
		});
		await event("review", "state_change", {
			type: "result",
			result: "VERDICT: CHANGES\nFix validation",
		});
		expect((await loadTaskMetrics(repos, projectId, child)).firstPass).toBe(false);
	});

	test("leaves historical broken delivery unknown without a review decision", async () => {
		child = { ...child, runId: await run("impl", 0), state: "pr_open" };
		await event("impl", "plan_run.review_finished", { outcome: "broken" });
		expect((await loadTaskMetrics(repos, projectId, child)).firstPass).toBeNull();
	});

	test("includes a dispatched retry and marks partial totals as incomplete observations", async () => {
		child = { ...child, runId: await run("impl", 0) };
		await run("retry", 20);
		await repos.runs.attachStats("retry", { costUsd: null, tokensOutput: null });
		await event("impl", "run.retry_dispatched", { retryRunId: "retry" });
		expect(await loadTaskMetrics(repos, projectId, child)).toMatchObject({
			runCount: 2,
			costUsd: 1.5,
			costUnknownRuns: 1,
			totalTokens: 150,
			tokenUnknownRuns: 1,
			activeMs: 20_000,
		});
	});
});
