import { loadTaskApproval } from "./approved-dispatch.ts";
import type { CoordinatorRepos } from "./coordinator.ts";
import { TaskBudgetExceededError, taskBudgetUsage } from "./task-budget.ts";

/** Durable intervals count external waiting separately from agent execution. */
export async function recordTaskWait(
	repos: CoordinatorRepos,
	planRunId: string,
	seq: number,
	waiting: boolean,
	now = new Date(),
) {
	if (!repos.taskAttempts) return;
	const attempts = await repos.taskAttempts.list(planRunId, seq);
	const waits = attempts.filter((row) => row.kind === "external_wait");
	const open = waits.find((row) => row.endedAt === null);
	if (open && !waiting) await repos.taskAttempts.finish(open.key, now.toISOString());
	if (!open && waiting)
		await repos.taskAttempts.reserve({
			key: `${planRunId}:${seq}:wait:${waits.length}`,
			planRunId,
			seq,
			kind: "external_wait",
			createdAt: now.toISOString(),
		});
}

export async function assertExternalWaitBudget(
	repos: CoordinatorRepos,
	planRunId: string,
	seq: number,
	now = new Date(),
) {
	if (!repos.taskAttempts) return;
	const approval = await loadTaskApproval(repos, planRunId, seq);
	if (!approval) return;
	const usage = await taskBudgetUsage(
		{ taskAttempts: repos.taskAttempts, runs: repos.runs },
		planRunId,
		seq,
		now,
	);
	if (usage.externalWaitMs >= approval.snapshot.budgets.externalWaitMs)
		throw new TaskBudgetExceededError(
			"External waiting budget exhausted; inspect the pending PR or release before approving continuation",
		);
}
