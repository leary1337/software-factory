import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow } from "../../api/types.ts";
import { costText, planCost, taskCost } from "./cost-summary.ts";

function task(
	costUsd: number | null,
	overrides: Partial<NonNullable<PlanRunChildRow["metrics"]>> = {},
): PlanRunChildRow {
	return {
		metrics: {
			costUsd,
			runCount: 29,
			costUnknownRuns: 0,
			missingRunCount: 0,
			incomplete: false,
			subscriptionEstimateRuns: 29,
			...overrides,
		},
	} as PlanRunChildRow;
}

describe("planCost", () => {
	test("uses whole-task metrics instead of implementation-only measurements", () => {
		const children = [task(8.56), task(2.44)];
		expect(costText(taskCost(children[0] as PlanRunChildRow))).toBe("$8.56");
		expect(planCost(children)).toMatchObject({
			amount: 11,
			runCount: 58,
			partial: false,
			estimateRuns: 58,
		});
	});
	test("keeps unknown measurements unknown and reports partial known sums", () => {
		const unavailable = {} as PlanRunChildRow;
		expect(costText(taskCost(unavailable))).toBe("Unknown");
		expect(costText(planCost([unavailable, task(null, { costUnknownRuns: 29 })]))).toBe("Unknown");
		const partial = planCost([task(8.56, { costUnknownRuns: 2 }), unavailable]);
		expect(costText(partial)).toBe("$8.56 + unknown");
		expect(partial).toMatchObject({ unknownRuns: 2, unavailableTasks: 1, partial: true });
	});
	test("distinguishes no execution, a measured zero and missing run links", () => {
		expect(costText(taskCost(task(0)))).toBe("$0.00");
		expect(costText(taskCost(task(null, { runCount: 0 })))).toBe("$0.00");
		expect(
			costText(taskCost(task(null, { runCount: 0, missingRunCount: 1, incomplete: true }))),
		).toBe("Unknown");
		expect(costText(planCost([]))).toBe("$0.00");
	});
	test("marks bounded lineage as partial even when all loaded run costs are known", () => {
		expect(costText(taskCost(task(1.25, { incomplete: true })))).toBe("$1.25 + unknown");
	});
	test("preserves sub-dollar precision consistently", () => {
		expect(costText(taskCost(task(0.005)))).toBe("$0.005");
		expect(costText(planCost([task(0.005)]))).toBe("$0.005");
	});
});
