import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow, PlanRunDetailResponse, PlanRunRow } from "../../api/types.ts";
import { childSummary } from "../plan-runs/walk-state.ts";
import { planProgressCounts } from "./plan-progress-summary.ts";
import { groupTaskAttempts, type TaskAttempt, taskExecutionId } from "./task-attempts.ts";
import { taskStatus } from "./task-status.ts";

const verification = {
	sha: "a".repeat(40),
	environment: "production",
	checks: { availability: true, version: true, scenario: true } as const,
	verifiedAt: "2026-01-01T00:00:00Z",
};

function attempt(
	id: string,
	plan: Partial<PlanRunRow> = {},
	child: Partial<PlanRunChildRow> = {},
): TaskAttempt {
	return {
		project: "Workout",
		child: {
			seq: 1,
			seedId: "issue-1",
			state: "running",
			title: "Task",
			...child,
		} as PlanRunChildRow,
		detail: {
			planRun: { id, projectId: "project-1", state: "running", createdAt: id, ...plan },
		} as PlanRunDetailResponse,
	};
}

describe("groupTaskAttempts", () => {
	test("counts a repeated plan child once when combining cached and selected attempts", () => {
		const current = attempt("2");
		const older = attempt("1", { state: "cancelled" });
		const [task] = groupTaskAttempts([current, older, current]);
		expect(task?.attempts).toHaveLength(2);
	});
	test("retains cancelled attempts under one current task regardless of renamed titles", () => {
		const old = attempt("1", { state: "cancelled" }, { title: "Old name" });
		const current = attempt("2");
		const [task] = groupTaskAttempts([old, current, attempt("0", { state: "cancelled" })]);
		expect(task?.current).toBe(current);
		expect(task?.attempts.map((row) => row.detail.planRun.id)).toEqual(["2", "1", "0"]);
		expect(task?.active).toEqual([current]);
		expect(task?.blockers).toEqual([]);
	});

	test("never groups matching names or tracker IDs from different projects", () => {
		const rows = [
			attempt("1"),
			attempt("2", { projectId: "project-2" }),
			attempt("3", {}, { seedId: "issue-2" }),
			attempt("4", {}, { seedId: "" }),
			attempt("5", {}, { seedId: "" }),
		];
		expect(groupTaskAttempts(rows)).toHaveLength(5);
	});

	test("keeps a reopened failure current instead of replacing it with an older delivery", () => {
		const delivered = attempt(
			"1",
			{ state: "succeeded" },
			{ state: "merged", productionVerification: verification },
		);
		const reopened = attempt("2", { state: "failed" }, { state: "failed" });
		const [task] = groupTaskAttempts([delivered, reopened]);
		expect(task?.current).toBe(reopened);
		expect(task?.delivered).toBe(delivered);
	});

	test("keeps simultaneous work, other open blockers and production incidents visible", () => {
		const blocker = attempt("3", {}, { state: "pr_open", reviewStage: "needs_attention" });
		const incident = attempt("0", { state: "cancelled" }, { failureReason: "deployment_incident" });
		const [task] = groupTaskAttempts([attempt("1"), attempt("2"), blocker, incident]);
		expect(task?.active).toHaveLength(2);
		expect(task?.blockers).toEqual([blocker]);
		expect(task?.incidents).toEqual([incident]);
	});

	test("does not label tracker closures as completed deliveries", () => {
		const skipped = attempt("2", { state: "succeeded" }, { state: "skipped" });
		const [task] = groupTaskAttempts([
			attempt("1", {}, { state: "merged", productionVerification: verification }),
			skipped,
		]);
		expect(task?.current).toBe(skipped);
		expect(task?.delivered?.detail.planRun.id).toBe("1");
		expect(taskStatus(skipped.child, skipped.detail.planRun).group).toBe("closed");
	});

	test("does not mark pending work behind a failed task as a separate incident", () => {
		const pending = attempt("1", { state: "failed" }, { state: "pending" });
		expect(taskStatus(pending.child, pending.detail.planRun).group).toBe("stopped");
	});
});

describe("taskExecutionId", () => {
	const review = {
		runId: "review",
		step: "review",
		executionState: "running",
		summary: null,
	} as const;
	const rework = { ...review, runId: "rework", step: "rework" } as const;
	const child = { runId: "implementation", reviewSteps: [review, rework] } as PlanRunChildRow;
	test("follows the current phase and does not reuse stale review history on implementation retry", () => {
		expect(taskExecutionId(child)).toBe("implementation");
		expect(taskExecutionId({ ...child, reviewStage: "reworking" })).toBe("rework");
		expect(taskExecutionId({ ...child, reviewStage: "reviewing" })).toBeNull();
		expect(
			taskExecutionId({ ...child, reviewStage: "reviewing", reviewSteps: [rework, review] }),
		).toBe("review");
		expect(
			taskExecutionId({ ...child, reviewStage: "reworking", reviewSteps: [review] }),
		).toBeNull();
		expect(
			taskExecutionId({ ...child, reviewStage: "reviewing", reviewSteps: undefined }),
		).toBeNull();
	});
});

describe("planProgressCounts", () => {
	test("separates delivery, closure, queue and failure and keeps task position after a resume", () => {
		const children = ["skipped", "skipped", "merged", "running", "pending", "failed"].map(
			(state) => ({ state }),
		) as PlanRunChildRow[];
		expect(planProgressCounts(children)).toEqual({
			merged: 1,
			delivered: 0,
			closed: 2,
			waiting: 1,
			failed: 1,
		});
		expect(childSummary("running", children)).toBe(
			"Task 4 of 6 · 1 merged · 0 release verified · 2 previously closed · 1 waiting · 1 failed",
		);
		expect(childSummary("cancelled", children)).not.toContain("Task 4");
		expect(childSummary("cancelled", children)).toContain("1 not started");
		expect(childSummary("succeeded", [])).toBe("No tasks");
	});
});
