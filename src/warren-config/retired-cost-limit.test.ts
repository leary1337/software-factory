import { describe, expect, test } from "bun:test";
import { PlanRunBudgetConfigSchema } from "./plan-run-budget-config.ts";
import { DefaultsConfigSchema, TriggerSchema } from "./schema.ts";

describe("retired monetary configuration", () => {
	test("loads existing settings without retaining monetary limits", () => {
		expect(DefaultsConfigSchema.parse({ maxCostUsd: 10, qualityGate: "bun test" })).toEqual({
			qualityGate: "bun test",
		});
		expect(
			PlanRunBudgetConfigSchema.parse({
				task: { maxCostUsd: 1, maxRuns: 3 },
				plan: { maxCostUsd: 10, maxActiveMs: 1000 },
			}),
		).toEqual({ task: { maxRuns: 3 }, plan: { maxActiveMs: 1000 } });
		const trigger = { id: "nightly", kind: "cron", cron: "0 0 * * *", role: "planner" } as const;
		expect(TriggerSchema.parse({ ...trigger, maxCostUsd: 5 })).toEqual(trigger);
	});

	test("keeps rejecting unknown fields and invalid surviving limits", () => {
		expect(DefaultsConfigSchema.safeParse({ defaultRoll: "planner" }).success).toBe(false);
		expect(PlanRunBudgetConfigSchema.safeParse({ task: { maxRuns: -1 } }).success).toBe(false);
		expect(TriggerSchema.safeParse(null).success).toBe(false);
	});
});
