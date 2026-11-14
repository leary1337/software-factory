import { z } from "zod";
import { PLAN_PERMISSION_KINDS, type TaskBudgetLimits } from "../core/plan-approval.ts";
export const PermissionSchema = z
	.object({
		kind: z.enum(PLAN_PERMISSION_KINDS),
		paths: z.array(z.string().trim().min(1)).min(1),
		reason: z.string().trim().min(1),
	})
	.strict();
export const ApprovalTaskSchema = z
	.object({
		id: z.string().trim().min(1).optional(),
		title: z.string().trim().min(1).max(500),
		description: z.string().trim().min(1).max(100_000),
		acceptance: z.array(z.string().trim().min(1)).min(1),
		dependsOn: z.array(z.number().int().positive()).optional(),
		releaseAfter: z.boolean().optional(),
		permissions: z.array(PermissionSchema).optional(),
	})
	.strict();
export const PrepareApprovalSchema = z
	.object({
		commandKey: z.string().trim().min(1).max(200),
		projectId: z.string().min(1),
		title: z.string().trim().min(1).max(500),
		tasks: z.array(ApprovalTaskSchema).min(1).max(500),
		permissions: z.array(PermissionSchema).optional(),
	})
	.strict();
export const DEFAULT_TASK_BUDGETS: TaskBudgetLimits = {
	repairs: 2,
	reworks: 3,
	runMs: 60 * 60_000,
	activeMs: 3 * 60 * 60_000,
	externalWaitMs: 60 * 60_000,
};
export const TaskBudgetSchema = z
	.object({
		repairs: z.number().int().min(0).max(10),
		reworks: z.number().int().min(0).max(20),
		runMs: z.number().int().positive(),
		activeMs: z.number().int().positive(),
		externalWaitMs: z.number().int().positive(),
	})
	.strict();
