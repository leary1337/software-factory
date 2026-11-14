import { expect, test } from "bun:test";
import { approvedFixture } from "./approval-test-helpers.ts";
import { repairFailedRelease } from "./deployment-repair.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import { reserveTaskAttempt } from "./task-budget.ts";

test("starts a fresh implementation after rollback and stops when its shared repair budget is exhausted", async () => {
	const f = await approvedFixture();
	try {
		const planRun = await f.repos.planRuns.transitionTo(f.planRun.id, "running");
		const old = await f.repos.runs.create({
			projectId: "project",
			agentName: "implementer",
			prompt: "task",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await f.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { state: "dispatched", runId: old.id },
		});
		const child = await f.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { state: "pr_open" },
		});
		const spawned: { role?: string; prompt: string; recovery?: string; existingBranch?: string }[] =
			[];
		const input: HandleInFlightInput = {
			planRun,
			child,
			repos: f.repos,
			now: () => new Date(),
			mergeTimeoutMs: 0,
			mergeStallWarningMs: 0,
			getIssue: async () => ({
				id: child.seedId,
				title: "Original task",
				description: "Original acceptance",
				status: "open",
			}),
			emit: async () => {},
			checkPrMerged: async () => ({ kind: "merged", mergedAt: new Date().toISOString() }),
			spawn: async (request) => {
				await reserveTaskAttempt(f.repos, {
					planRunId: planRun.id,
					seq: 1,
					kind: "repair",
					attemptKey: request.attemptKey ?? "missing",
				});
				spawned.push({
					role: request.agentName,
					prompt: request.prompt,
					recovery: request.recoveryOf,
					existingBranch: request.existingBranch,
				});
				const run = await f.repos.runs.create({
					projectId: "project",
					agentName: "implementer",
					prompt: request.prompt,
					renderedAgentJson: {},
					trigger: "plan-run",
					retryOf: request.recoveryOf,
				});
				return { runId: run.id };
			},
		};
		expect(await repairFailedRelease(input, old, "scenario failed", "b".repeat(40))).toMatchObject({
			kind: "result",
			result: { kind: "dispatched" },
		});
		expect(spawned[0]).toMatchObject({
			role: "implementer",
			recovery: old.id,
			existingBranch: undefined,
		});
		expect(spawned[0]?.prompt).toContain("Original acceptance");
		const current = (await f.repos.planRuns.listChildren(planRun.id))[0];
		expect(current?.state).toBe("dispatched");
		await reserveTaskAttempt(f.repos, {
			planRunId: planRun.id,
			seq: 1,
			kind: "repair",
			attemptKey: "other-repair",
		});
		await f.reopen();
		const run = await f.repos.runs.require(current?.runId ?? "missing");
		await f.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { state: "pr_open" },
		});
		expect(
			await repairFailedRelease(
				{ ...input, repos: f.repos },
				run,
				"scenario failed again",
				"b".repeat(40),
			),
		).toMatchObject({
			kind: "result",
			result: { kind: "plan_failed", reason: expect.stringContaining("repair budget exhausted") },
		});
		expect(spawned).toHaveLength(1);
	} finally {
		await f.dispose();
	}
});
