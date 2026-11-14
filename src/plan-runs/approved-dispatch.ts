import { ValidationError } from "../core/errors.ts";
import type { ApprovedTask, PlanApproval } from "../core/plan-approval.ts";
import { readCachedAgent } from "../runs/spawn/agent-cache.ts";
import type { SpawnRunInput } from "../runs/spawn/types.ts";
import { profileForRole } from "../runtime/adapters/execution-profiles.ts";
import { DefaultsConfigSchema } from "../warren-config/schema.ts";
import type { CoordinatorGetIssueFn, CoordinatorRepos } from "./coordinator.ts";
import { loadReviewBudget } from "./review-progress.ts";

export function taskDescription(task: ApprovedTask): string {
	return `${task.description}\n\n## Acceptance criteria\n${task.acceptance.map((criterion) => `- ${criterion}`).join("\n")}`;
}
export async function approvedIssueReader(
	repos: CoordinatorRepos,
	planRunId: string,
	fallback: CoordinatorGetIssueFn,
): Promise<CoordinatorGetIssueFn> {
	const approval = await repos.planApprovals?.forRun(planRunId);
	if (!approval) return fallback;
	return async (projectId, id) => {
		const task = approval.snapshot.tasks.find((task) => task.id === id);
		if (!task || projectId !== approval.snapshot.projectId)
			throw new ValidationError("Task is not part of the approved plan");
		return {
			id,
			title: task.title,
			description: taskDescription(task),
			status: task.initialStatus,
			metadata: { approvalId: approval.id },
		};
	};
}
export function approvedSpawnOptions(
	approval: PlanApproval | null,
	role: string,
): Partial<SpawnRunInput> {
	if (!approval) return {};
	const snapshot = approval.snapshot;
	const agent = snapshot.agents[role];
	if (!agent) throw new ValidationError(`Role ${role} was not frozen in the approved plan`);
	return {
		approvedDefaults: DefaultsConfigSchema.parse(snapshot.settings),
		agentSnapshot: readCachedAgent(agent, role),
		executionProfile: profileForRole(snapshot.profiles, role),
		toolkitVersion: snapshot.toolkitVersion,
		timeoutMs: snapshot.budgets.runMs,
	};
}

export function approvalMetadata(approval: PlanApproval | null): Record<string, unknown> {
	return approval ? { approvalId: approval.id, revision: approval.revision } : {};
}

/** Running steps retain the revision that was in force when they started. */
export async function loadTaskApproval(
	repos: Partial<Pick<CoordinatorRepos, "planApprovals">>,
	planRunId: string,
	seq: number,
): Promise<PlanApproval | null> {
	const history = await repos.planApprovals?.history(planRunId);
	const latest = history?.[0];
	if (!latest) return null;
	const revision = latest.snapshot.tasks.find((task) => task.seq === seq)?.revision ?? 1;
	return history?.find((approval) => approval.revision === revision) ?? null;
}

/** Approved tasks use their frozen allowance; legacy rows retain the previous policy. */
export async function approvedReviewBudget(
	repos: Parameters<typeof loadTaskApproval>[0],
	planRunId: string,
	seq: number,
) {
	const approval = await loadTaskApproval(repos, planRunId, seq);
	return approval
		? {
				maxReworks: approval.snapshot.budgets.reworks,
				maxActiveMs: approval.snapshot.budgets.activeMs,
				stopOnNoProgress: true,
			}
		: loadReviewBudget();
}
