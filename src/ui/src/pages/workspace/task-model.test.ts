import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow, PlanRunDetailResponse, RunRow } from "../../api/types.ts";
import { buildWorkspaceTasks, currentProjectTasks } from "./task-model.ts";

function run(id: string, patch: Partial<RunRow> = {}): RunRow {
	return {
		id,
		projectId: "project",
		seedId: null,
		parentRunId: null,
		retryOf: null,
		state: "running",
		createdAt: 1,
		prompt: "A task",
		...patch,
	} as RunRow;
}
function plan(child: Partial<PlanRunChildRow> = {}): PlanRunDetailResponse {
	return {
		planRun: { id: "plan", projectId: "project", state: "running", createdAt: "2026-01-01" },
		children: [
			{
				planRunId: "plan",
				seq: 1,
				seedId: "issue",
				runId: "implementation",
				title: "Plan task",
				state: "running",
				...child,
			},
		],
		runs: [run("implementation", { seedId: "issue" })],
	} as PlanRunDetailResponse;
}

describe("buildWorkspaceTasks", () => {
	test("keeps reviewer and rework executions inside the logical task", () => {
		const detail = plan({
			reviewStage: "reviewing",
			state: "pr_open",
			reviewSteps: [{ runId: "review", step: "review", executionState: "running", summary: null }],
		});
		const tasks = buildWorkspaceTasks([detail], [run("implementation"), run("review")]);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ column: "Review", attention: false, runId: "review" });
		expect(tasks[0]?.runs).toHaveLength(2);
	});
	test("groups retries and continuation chains, keeping the live attempt current", () => {
		const tasks = buildWorkspaceTasks(
			[],
			[
				run("one", { state: "failed" }),
				run("two", { retryOf: "one", state: "failed", createdAt: 2 }),
				run("three", { parentRunId: "two", createdAt: 3 }),
			],
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({ runId: "three", attention: false, column: "In progress" });
		expect(tasks[0]?.runs).toHaveLength(3);
	});
	test("never groups matching titles or tracker ids across projects", () => {
		expect(
			buildWorkspaceTasks(
				[],
				[
					run("one", { seedId: "issue" }),
					run("two", { seedId: "issue", projectId: "other" }),
					run("three"),
					run("four"),
				],
			),
		).toHaveLength(4);
	});
	test("distinguishes execution success, merge and verified Production", () => {
		expect(buildWorkspaceTasks([], [run("done", { state: "succeeded" })])[0]?.column).toBe(
			"Ready for review",
		);
		expect(buildWorkspaceTasks([plan({ state: "merged" })], [])[0]?.column).toBe("Merged");
		expect(
			buildWorkspaceTasks(
				[
					plan({
						state: "merged",
						productionVerification: {
							sha: "abc",
							environment: "production",
							verifiedAt: "2026-01-02",
						},
					}),
				],
				[],
			)[0]?.column,
		).toBe("Production");
	});
	test("does not turn an automatic merge retry into a human request", () => {
		const retry = plan({
			state: "pr_open",
			reviewMerge: {
				kind: "retry",
				reason: "rate_limited",
				detail: "Wait",
				nextAction: "Retry automatically",
			} as PlanRunChildRow["reviewMerge"],
		});
		expect(buildWorkspaceTasks([retry], [])[0]?.attention).toBe(false);
	});
	test("surfaces blocked merge and Production incidents even after merging", () => {
		const blocked = plan({
			state: "pr_open",
			reviewMerge: {
				kind: "blocked",
				reason: "protected_path",
				detail: "Protected paths",
				nextAction: "Review manually",
			},
		});
		expect(buildWorkspaceTasks([blocked], [])[0]?.attention).toBe(true);
		const incident = plan({
			state: "failed",
			prMergedAt: "2026-01-01",
			failureReason: "deployment_incident",
		});
		expect(buildWorkspaceTasks([incident], [])[0]).toMatchObject({
			attention: true,
			column: "Merged",
		});
	});
	test("keeps cancelled executions out of the action queue", () => {
		expect(buildWorkspaceTasks([], [run("one", { state: "cancelled" })])[0]).toMatchObject({
			attention: false,
			column: "Stopped",
		});
	});
	test("attaches standalone tracker attempts to the matching plan task", () => {
		const tasks = buildWorkspaceTasks(
			[plan()],
			[run("older", { seedId: "issue", state: "failed" })],
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.runs).toHaveLength(2);
	});
	test("shows a new manual continuation after a stopped plan without cancelling the old plan", () => {
		const detail = plan({ state: "failed" });
		detail.planRun.state = "failed";
		const newer = run("manual", {
			parentRunId: "implementation",
			createdAt: Date.parse("2026-01-02"),
		});
		const [task] = buildWorkspaceTasks([detail], [newer]);
		expect(task).toMatchObject({ column: "In progress", attention: false, runId: "manual" });
		expect(task?.currentPlan).toBeUndefined();
		expect(task?.plan?.attempts).toHaveLength(1);
	});

	test("terminates malformed cyclic continuation links", () => {
		expect(
			buildWorkspaceTasks([], [run("a", { parentRunId: "b" }), run("b", { parentRunId: "a" })])
				.length,
		).toBeGreaterThan(0);
	});
});

describe("currentProjectTasks", () => {
	test("keeps live work visible ahead of a newer queue in the three-task summary", () => {
		const tasks = buildWorkspaceTasks(
			[],
			[
				run("active"),
				...[2, 3, 4, 5].map((n) => run(`queued-${n}`, { state: "queued", createdAt: n })),
				run("other", { projectId: "other" }),
				run("failed", { state: "failed" }),
			],
		);
		const visible = currentProjectTasks(tasks, "project").slice(0, 3);
		expect(visible).toHaveLength(3);
		expect(visible[0]?.runId).toBe("active");
		expect(visible.every((task) => !task.attention && task.projectId === "project")).toBe(true);
	});
});
