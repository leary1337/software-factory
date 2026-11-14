import { StateTransitionError } from "../core/errors.ts";
import type { TaskAttemptKind } from "../core/plan-approval.ts";
import type { Repos } from "../db/repos/index.ts";
import { loadTaskApproval } from "./approved-dispatch.ts";
import { withPlanRunLock } from "./lock.ts";

export class TaskBudgetExceededError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}
export interface ReserveTaskAttempt {
	planRunId: string;
	seq: number;
	kind: TaskAttemptKind;
	attemptKey: string;
	now?: Date;
}
/** Active elapsed time comes from durable run rows, including preparation and checks. */
export async function taskBudgetUsage(
	repos: Pick<Repos, "taskAttempts" | "runs">,
	planRunId: string,
	seq: number,
	now = new Date(),
) {
	const attempts = await repos.taskAttempts.list(planRunId, seq);
	let activeMs = 0;
	for (const runId of new Set(
		attempts.map((attempt) => attempt.runId).filter((id): id is string => id !== null),
	)) {
		const run = await repos.runs.get(runId);
		if (!run)
			throw new TaskBudgetExceededError(
				"Task budget cannot be verified because an attempt is missing",
			);
		const started = run.createdAt ?? Date.parse(run.startedAt ?? "");
		const ended = run.endedAt ? Date.parse(run.endedAt) : now.getTime();
		if (!Number.isFinite(started) || !Number.isFinite(ended))
			throw new TaskBudgetExceededError("Task timing cannot be verified");
		activeMs += Math.max(0, ended - started);
	}
	const waits = attempts.filter((attempt) => attempt.kind === "external_wait");
	return {
		attempts,
		activeMs,
		externalWaitMs: waits.reduce(
			(sum, wait) =>
				sum +
				Math.max(
					0,
					(wait.endedAt ? Date.parse(wait.endedAt) : now.getTime()) - Date.parse(wait.createdAt),
				),
			0,
		),
		repairs: attempts.filter((attempt) => attempt.kind === "repair").length,
		reworks: attempts.filter((attempt) => attempt.kind === "rework").length,
	};
}
export async function reserveTaskAttempt(repos: Repos, input: ReserveTaskAttempt) {
	return withPlanRunLock(`budget:${input.planRunId}:${input.seq}`, async () => {
		const existing = await repos.taskAttempts.get(input.attemptKey);
		if (existing) {
			if (
				existing.planRunId !== input.planRunId ||
				existing.seq !== input.seq ||
				existing.kind !== input.kind
			)
				throw new StateTransitionError("Attempt identity conflicts with another task");
			return existing;
		}
		const approval = await loadTaskApproval(repos, input.planRunId, input.seq);
		if (!approval)
			throw new TaskBudgetExceededError(
				"This recovery needs an approved plan with a persisted budget",
			);
		const usage = await taskBudgetUsage(repos, input.planRunId, input.seq, input.now);
		assertTaskBudget(usage, approval.snapshot.budgets, input.kind);
		return repos.taskAttempts.reserve({
			key: input.attemptKey,
			planRunId: input.planRunId,
			seq: input.seq,
			kind: input.kind,
			createdAt: (input.now ?? new Date()).toISOString(),
		});
	});
}
export async function attachTaskAttemptRun(
	repos: Pick<Repos, "taskAttempts">,
	attemptKey: string,
	runId: string,
) {
	await repos.taskAttempts.attach(attemptKey, runId);
}

function assertTaskBudget(
	usage: Awaited<ReturnType<typeof taskBudgetUsage>>,
	limits: import("../core/plan-approval.ts").TaskBudgetLimits,
	kind: TaskAttemptKind,
): void {
	if (usage.activeMs >= limits.activeMs)
		throw new TaskBudgetExceededError(
			"Task active-time budget exhausted; review the result before increasing the budget",
		);
	if (usage.externalWaitMs >= limits.externalWaitMs)
		throw new TaskBudgetExceededError(
			"External waiting budget exhausted; resolve the pending action before continuing",
		);
	if (kind === "repair" && usage.repairs >= limits.repairs)
		throw new TaskBudgetExceededError("Task repair budget exhausted");
	if (kind === "rework" && usage.reworks >= limits.reworks)
		throw new TaskBudgetExceededError("Task rework budget exhausted");
}

/** Boot adapter for the runtime's bounded transient-install retries. */
export function environmentRepairBudget(repos: Repos) {
	return async (runId: string, stage: string, attempt: number, _reason: string): Promise<void> => {
		const resolved =
			(await repos.planRuns.findChildByRunId(runId)) ?? (await repos.taskAttempts.forRun(runId));
		if (!resolved)
			throw new TaskBudgetExceededError("Environment repair requires an approved task budget");
		const attemptKey = `${runId}:${stage}:environment:${attempt}`;
		await reserveTaskAttempt(repos, {
			planRunId: resolved.planRunId,
			seq: resolved.seq,
			kind: "repair",
			attemptKey,
		});
		await attachTaskAttemptRun(repos, attemptKey, runId);
	};
}
