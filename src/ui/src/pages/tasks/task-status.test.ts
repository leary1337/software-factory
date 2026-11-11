import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow, PlanRunRow } from "../../api/types.ts";
import { taskStatus } from "./task-status.ts";

const plan = { state: "running" } as PlanRunRow;
const child = { state: "pr_open", reviewStage: "ready_to_merge" } as PlanRunChildRow;

describe("taskStatus", () => {
	test("prioritizes a production incident after an earlier refused merge", () => {
		const result = taskStatus(
			{
				...child,
				state: "failed",
				failureReason: "deployment_incident",
				reviewMerge: {
					kind: "blocked",
					reason: "protection_required",
					detail: "Protection missing",
					nextAction: "Configure protection.",
				},
			},
			{ ...plan, state: "failed" },
		);
		expect(result.label).toBe("Production incident");
		expect(result.action).toContain("production");
	});
	test("keeps policy refusals visible despite a passing review", () => {
		const result = taskStatus(
			{
				...child,
				reviewMerge: {
					kind: "blocked",
					reason: "protected_path",
					detail: "Protected file changed",
					nextAction: "Review the migration manually.",
				},
			},
			plan,
		);
		expect(result.group).toBe("attention");
		expect(result.action).toBe("Review the migration manually.");
	});
	test("distinguishes a transient delivery retry from owner attention", () => {
		expect(
			taskStatus(
				{
					...child,
					reviewMerge: {
						kind: "retry",
						reason: "network",
						detail: "GitHub unavailable",
						nextAction: "Retry pending.",
					},
				},
				plan,
			).group,
		).toBe("waiting");
	});
	test("stops displaying an interrupted plan as active work", () => {
		expect(
			taskStatus(
				{ ...child, state: "dispatched", reviewStage: "reviewing" },
				{ ...plan, state: "cancelled" },
			).group,
		).toBe("stopped");
	});
	test("preserves completed tasks when a later task stops the plan", () => {
		expect(taskStatus({ ...child, state: "merged" }, { ...plan, state: "failed" }).group).toBe(
			"complete",
		);
	});
});
