import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StateTransitionError, ValidationError } from "../core/errors.ts";
import type { ApprovedTask, RevisePlanApproval } from "../core/plan-approval.ts";
import type { Repos } from "../db/repos/index.ts";
import { resolveExecutionProfiles } from "../runtime/adapters/execution-profiles.ts";
import { DefaultsConfigSchema } from "../warren-config/schema.ts";
import { approvalDigest } from "./approval.ts";
import { ApprovalTaskSchema, PermissionSchema, TaskBudgetSchema } from "./approval-schema.ts";
import { withPlanRunLock } from "./lock.ts";

export const RevisePlanSchema = z
	.object({
		commandKey: z.string().trim().min(1).max(200),
		expectedRevision: z.number().int().positive(),
		decision: z.string().trim().min(1).max(5000),
		tasks: z.array(ApprovalTaskSchema.extend({ seq: z.number().int().positive() })).min(1),
		permissions: z.array(PermissionSchema).optional(),
		settings: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type RevisePlanInput = RevisePlanApproval;

/** Apply an explicit owner decision only to work that has not begun. */
export async function reviseApprovedPlan(repos: Repos, planRunId: string, raw: RevisePlanInput) {
	const parsed = RevisePlanSchema.safeParse(raw);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const input = parsed.data;
	return withPlanRunLock(planRunId, async () => {
		const repeated = await repos.planApprovals.byCommand(input.commandKey);
		if (repeated) {
			if (
				repeated.planRunId !== planRunId ||
				repeated.snapshot.requestDigest !== approvalDigest(input)
			)
				throw new ValidationError("Revision command key is already used");
			return repeated;
		}
		const current = await repos.planApprovals.forRun(planRunId);
		if (!current)
			throw new ValidationError("Historical plans without an approval snapshot cannot be revised");
		if (current.revision !== input.expectedRevision)
			throw new StateTransitionError(
				"Plan revision changed. Reload before applying this decision.",
			);
		const run = await repos.planRuns.require(planRunId);
		if (run.state !== "queued" && run.state !== "running")
			throw new StateTransitionError("Only an active plan can be revised");
		const children = await repos.planRuns.listChildren(planRunId);
		const revision = current.revision + 1;
		const tasks = reviseTasks(current.snapshot.tasks, children, input.tasks, revision);
		const settings = DefaultsConfigSchema.parse({
			...current.snapshot.settings,
			...input.settings,
		});
		const snapshot = {
			...current.snapshot,
			requestDigest: approvalDigest(input),
			tasks,
			settings,
			profiles: resolveExecutionProfiles(settings),
			budgets: TaskBudgetSchema.parse({ ...current.snapshot.budgets, ...settings.taskBudgets }),
			permissions: input.permissions ?? current.snapshot.permissions,
		};
		const row = {
			id: `approval_${randomUUID()}`,
			commandKey: input.commandKey,
			digest: approvalDigest(snapshot),
			snapshot,
			revision,
			supersedesId: current.id,
			planRunId,
			decision: input.decision,
			createdAt: new Date().toISOString(),
		};
		return repos.planApprovals.applyRevision(row, input.expectedRevision);
	});
}
function reviseTasks(
	original: readonly ApprovedTask[],
	children: readonly { seq: number; state: string }[],
	updates: RevisePlanInput["tasks"],
	revision: number,
): ApprovedTask[] {
	const started = new Set(
		children.filter((child) => child.state !== "pending").map((child) => child.seq),
	);
	const tasks = original.filter((task) => started.has(task.seq));
	const sequences = new Set<number>();
	for (const update of updates) {
		if (sequences.has(update.seq)) throw new ValidationError("Duplicate step sequence");
		sequences.add(update.seq);
		const previous = original.find((task) => task.seq === update.seq);
		const task: ApprovedTask = {
			...update,
			id: update.id ?? previous?.id ?? `factory-${randomUUID()}`,
			dependsOn: update.dependsOn ?? previous?.dependsOn ?? [],
			releaseAfter: update.releaseAfter ?? previous?.releaseAfter ?? false,
			permissions: update.permissions ?? previous?.permissions ?? [],
			initialStatus: previous?.initialStatus ?? "open",
			revision,
		};
		if (started.has(update.seq)) {
			if (approvalDigest({ ...previous, revision }) !== approvalDigest(task))
				throw new ValidationError("Started and completed tasks cannot be rewritten");
		} else tasks.push(task);
	}
	tasks.sort((a, b) => a.seq - b.seq);
	if (!tasks.length) throw new ValidationError("A revision must retain at least one task");
	validateDependencies(tasks);
	return tasks;
}

function validateDependencies(tasks: readonly ApprovedTask[]): void {
	const ids = new Set(tasks.map((task) => task.id));
	if (ids.size !== tasks.length) throw new ValidationError("Duplicate task ID");
	for (const task of tasks)
		if (
			task.dependsOn.some(
				(seq) => seq >= task.seq || !tasks.some((dependency) => dependency.seq === seq),
			)
		)
			throw new ValidationError("A task dependency is absent or not earlier in the plan");
}
