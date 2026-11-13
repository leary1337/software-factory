import { z } from "zod";
import { omitRetiredCostLimit } from "./retired-cost-limit.ts";

const LimitsSchema = z.preprocess(
	omitRetiredCostLimit,
	z
		.object({
			maxRuns: z.number().int().positive().optional(),
			maxActiveMs: z.number().int().positive().optional(),
		})
		.strict(),
);

export const PlanRunBudgetConfigSchema = z
	.object({
		task: LimitsSchema.optional(),
		plan: LimitsSchema.optional(),
	})
	.strict();
