import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow } from "../../api/types.ts";
import {
	costText,
	planCost,
	preciseCostText,
	roundingAdjustment,
	sumCosts,
	taskCost,
} from "./cost-summary.ts";

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

describe("attempt cost presentation", () => {
	test("sums original measurements before display rounding", () => {
		const costs = [taskCost(task(8.5644)), taskCost(task(2.8644))];
		expect(costs.map(costText)).toEqual(["$8.56", "$2.86"]);
		expect(costText(sumCosts(costs))).toBe("$11.43");
		expect(preciseCostText(sumCosts(costs))).toBe("$11.428800");
		expect(roundingAdjustment(costs)).toBe("+$0.01");
	});
	test("explains negative and sub-cent rounding without inventing a charge", () => {
		expect(roundingAdjustment([taskCost(task(1.006)), taskCost(task(1.006))])).toBe("−$0.01");
		expect(roundingAdjustment([taskCost(task(0.0006)), taskCost(task(0.0006))])).toBe("−$0.001");
		expect(roundingAdjustment([taskCost(task(1)), taskCost(task(2))])).toBeNull();
	});
	test("preserves unknown costs and subscription estimates across attempts", () => {
		const total = sumCosts([taskCost(task(8.5644)), taskCost(task(null, { costUnknownRuns: 1 }))]);
		expect(costText(total)).toBe("$8.56 + unknown");
		expect(preciseCostText(total)).toBe("$8.564400 + unknown");
		expect(total.estimateRuns).toBe(58);
		expect(preciseCostText(taskCost(task(null)))).toBe("Unknown");
		expect(preciseCostText(taskCost(task(0.0000001)))).toBe("<$0.000001");
	});
	test("keeps mixed row precision in a rounding difference larger than one cent", () => {
		const costs = [1.0044, 1.0044, 1.0044, 0.9944].map((amount) => taskCost(task(amount)));
		expect(roundingAdjustment(costs)).toBe("+$0.016");
	});
});
