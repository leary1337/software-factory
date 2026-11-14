import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { approvedFixture } from "./approval-test-helpers.ts";
import { attachTaskAttemptRun, reserveTaskAttempt, taskBudgetUsage } from "./task-budget.ts";
import { assertExternalWaitBudget, recordTaskWait } from "./task-wait.ts";

let fixture: Awaited<ReturnType<typeof approvedFixture>>;
beforeEach(async () => {
	fixture = await approvedFixture();
});
afterEach(async () => {
	await fixture.dispose();
});
describe("durable task budget", () => {
	test("retains separate external wait intervals and stops after an aggregate hour across restart", async () => {
		const start = new Date("2026-01-01T00:00:00Z");
		const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
		await recordTaskWait(fixture.repos, fixture.planRun.id, 1, true, start);
		await recordTaskWait(fixture.repos, fixture.planRun.id, 1, false, at(30));
		await fixture.reopen();
		expect(
			(await taskBudgetUsage(fixture.repos, fixture.planRun.id, 1, at(90))).externalWaitMs,
		).toBe(30 * 60_000);
		await recordTaskWait(fixture.repos, fixture.planRun.id, 1, true, at(90));
		await expect(
			assertExternalWaitBudget(fixture.repos, fixture.planRun.id, 1, at(120)),
		).rejects.toThrow("waiting budget exhausted");
		expect((await taskBudgetUsage(fixture.repos, fixture.planRun.id, 1, at(120))).activeMs).toBe(0);
	});
	test("keeps two repair reservations across restart and treats repeated commands idempotently", async () => {
		const input = { planRunId: fixture.planRun.id, seq: 1, kind: "repair" as const };
		await reserveTaskAttempt(fixture.repos, { ...input, attemptKey: "repair1" });
		await reserveTaskAttempt(fixture.repos, { ...input, attemptKey: "repair1" });
		await fixture.reopen();
		await reserveTaskAttempt(fixture.repos, { ...input, attemptKey: "repair2" });
		await expect(
			reserveTaskAttempt(fixture.repos, { ...input, attemptKey: "repair3" }),
		).rejects.toThrow("repair budget exhausted");
		expect((await taskBudgetUsage(fixture.repos, fixture.planRun.id, 1)).repairs).toBe(2);
	});
	test("counts preparation from durable run creation and rejects a new attempt after three active hours", async () => {
		const start = new Date("2026-01-01T00:00:00Z");
		const input = {
			planRunId: fixture.planRun.id,
			seq: 1,
			kind: "implementation" as const,
			attemptKey: "implementation1",
			now: start,
		};
		await reserveTaskAttempt(fixture.repos, input);
		const run = await fixture.repos.runs.create({
			agentName: "implementer",
			projectId: "project",
			prompt: "task",
			renderedAgentJson: {},
			trigger: "plan-run",
			now: start,
		});
		await attachTaskAttemptRun(fixture.repos, input.attemptKey, run.id);
		await fixture.reopen();
		const now = new Date(start.getTime() + 3 * 60 * 60_000);
		await expect(
			reserveTaskAttempt(fixture.repos, { ...input, kind: "review", attemptKey: "review1", now }),
		).rejects.toThrow("active-time budget exhausted");
	});
});
