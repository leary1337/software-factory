import type { PlanApproval } from "../core/plan-approval.ts";
import type { Repos } from "../db/repos/index.ts";
import { approvedSpawnOptions } from "./approved-dispatch.ts";
import type { CoordinatorSpawnInput } from "./coordinator.ts";
import { loadSteps } from "./review.ts";
import { reserveTaskAttempt, taskBudgetUsage } from "./task-budget.ts";

export async function reserveDispatchAttempt(
	repos: Repos,
	approval: PlanApproval | null,
	input: CoordinatorSpawnInput,
	role: string,
) {
	if (!approval) return null;
	const sequence =
		role === input.planRun.agentName
			? input.child.retryCount
			: input.child.runId
				? (await loadSteps(repos, input.child.runId)).length
				: 0;
	const kind =
		input.attemptKind ??
		(role === "rework"
			? "rework"
			: role === "reviewer"
				? "review"
				: sequence > 0
					? "repair"
					: "implementation");
	const attemptKey =
		input.attemptKey ?? `${input.planRun.id}:${input.child.seq}:${role}:${sequence}`;
	return reserveTaskAttempt(repos, {
		planRunId: input.planRun.id,
		seq: input.child.seq,
		kind,
		attemptKey,
	});
}

export async function budgetedSpawnOptions(
	repos: Repos,
	approval: PlanApproval | null,
	role: string,
	planRunId: string,
	seq: number,
	now?: () => Date,
) {
	const options = approvedSpawnOptions(approval, role);
	if (!approval) return options;
	const usage = await taskBudgetUsage(repos, planRunId, seq, now?.());
	return {
		...options,
		timeoutMs: Math.min(
			approval.snapshot.budgets.runMs,
			Math.max(1, approval.snapshot.budgets.activeMs - usage.activeMs),
		),
	};
}
