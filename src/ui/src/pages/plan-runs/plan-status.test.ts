import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow } from "../../api/types.ts";
import { planStatus } from "./plan-status.ts";

const blocked = {
	seq: 7,
	state: "pr_open",
	reviewStage: "needs_attention",
	reviewMerge: {
		kind: "blocked",
		reason: "protected_path",
		detail: "Protected file changed",
		nextAction: "Inspect the pull request.",
	},
} as PlanRunChildRow;

describe("planStatus", () => {
	test("uses the current delivery gate instead of claiming the plan is running", () => {
		const tasks = [
			{ ...blocked, seq: 8, state: "pending", reviewMerge: null },
			blocked,
			{ ...blocked, seq: 6, state: "merged" },
		] as PlanRunChildRow[];
		expect(planStatus("running", tasks).label).toBe("Awaiting merge decision");
	});
	test("distinguishes a pending retry from a manual decision", () => {
		expect(
			planStatus("running", [
				{
					...blocked,
					reviewMerge: {
						kind: "retry",
						reason: "network",
						detail: "Unavailable",
						nextAction: "Retry pending.",
					},
				},
			]).label,
		).toBe("Merge retry pending");
	});
	test("preserves the plan lifecycle once the attempt ends", () => {
		expect(planStatus("succeeded", [blocked]).label).toBe("Completed");
		expect(planStatus("failed", [blocked]).label).toBe("Stopped");
		expect(planStatus("cancelled", [blocked]).label).toBe("Cancelled");
	});
	test("does not infer active execution before task data arrives", () => {
		expect(planStatus("running").label).toBe("Status pending");
	});
});
