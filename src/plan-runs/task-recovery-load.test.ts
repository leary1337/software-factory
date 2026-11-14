import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow } from "../db/schema.ts";
import { loadTaskObservations } from "./task-metrics-load.ts";

describe("loadTaskObservations recovery history", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;
	let child: PlanRunChildRow;
	let clock: number;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		clock = Date.UTC(2026, 10, 14);
		projectId = (
			await repos.projects.create({
				gitUrl: "https://github.com/test/recovery",
				localPath: "/tmp/recovery",
				defaultBranch: "main",
				hasSeeds: false,
			})
		).id;
		const plan = await repos.planRuns.create({
			projectId,
			agentName: "implementer",
			planId: "plan",
			children: [{ seq: 1, seedId: "task" }],
		});
		const first = plan.children[0];
		if (!first) throw new Error("Missing fixture child");
		child = first;
	});
	afterEach(() => db.close());
	async function run(id: string) {
		await repos.runs.create({
			id,
			projectId,
			agentName: "implementer",
			prompt: "task",
			renderedAgentJson: {},
			trigger: "plan-run",
			now: new Date(clock),
		});
	}
	async function event(runId: string, kind: string, payload: Record<string, unknown> = {}) {
		clock += 1000;
		await repos.events.append({
			runId,
			kind,
			payload,
			stream: "system",
			ts: new Date(clock).toISOString(),
			sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
		});
	}
	test("finds the prior rollback and current reviewer repair through persisted task links", async () => {
		for (const id of ["original", "repair", "reviewer"]) await run(id);
		const expectedSha = "a".repeat(40);
		await event("original", "plan_run.rollback_attempt", { expectedSha, reason: "Browser failed" });
		await event("original", "plan_run.rollback_verified", {
			expectedSha,
			reason: "Browser failed",
			verification: { availability: true, version: true, scenario: true },
		});
		await event("repair", "plan_run.deployment_repair", { previousRunId: "original" });
		await event("repair", "plan_run.review_step", { stepRunId: "reviewer", step: "review" });
		await event("reviewer", "preparation.repair_started", {
			attempt: 1,
			reason: "Registry timeout",
			action: "Retry install",
		});
		await event("reviewer", "preparation.repair_stopped", {
			attempt: 2,
			reason: "Shared budget exhausted",
		});
		await event("original", "plan_run.child_retried", { previousRunId: "repair" });
		child = { ...child, runId: "repair" };
		const result = await loadTaskObservations(repos, projectId, child);
		expect(result.metrics.runCount).toBe(3);
		expect(result.recovery).toMatchObject({
			preparation: { state: "stopped", attempt: 1, reason: "Registry timeout" },
			rollback: { state: "verified", sha: expectedSha },
		});
	});
	test("ignores same-ticket unrelated runs and broken links without inventing recovery", async () => {
		await run("current");
		await run("unrelated");
		await event("unrelated", "plan_run.rollback_failed", { reason: "Unrelated release" });
		await event("current", "plan_run.review_step", { stepRunId: "missing", step: "review" });
		const result = await loadTaskObservations(repos, projectId, { ...child, runId: "current" });
		expect(result.recovery).toEqual({ preparation: null, rollback: null });
		expect(result.metrics.missingRunCount).toBe(1);
	});
});
