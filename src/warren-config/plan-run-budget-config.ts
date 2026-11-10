import { z } from "zod";

const LimitsSchema = z
	.object({
		maxRuns: z.number().int().positive().optional(),
		maxActiveMs: z.number().int().positive().optional(),
		maxCostUsd: z.number().finite().positive().optional(),
	})
	.strict();

export const PlanRunBudgetConfigSchema = z
	.object({
		task: LimitsSchema.optional(),
		plan: LimitsSchema.optional(),
	})
	.strict();
