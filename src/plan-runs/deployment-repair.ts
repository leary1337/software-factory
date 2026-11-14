import { formatError } from "../core/errors.ts";
import type { RunRow } from "../db/schema.ts";
import { PlanRunSpawnDeferredError } from "./errors.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";

/** A verified rollback authorizes a bounded fresh implementation, followed by ordinary review. */
export async function repairFailedRelease(
	input: HandleInFlightInput,
	run: RunRow,
	reason: string,
	restoredSha: string,
): Promise<HandleInFlightDecision> {
	const { repos, planRun, child } = input;
	const issue = await input.getIssue(planRun.projectId, child.seedId);
	try {
		const spawned = await input.spawn({
			planRun,
			child,
			agentName: planRun.agentName,
			attemptKind: "repair",
			attemptKey: `${planRun.id}:${child.seq}:release-repair:${run.id}`,
			recoveryOf: run.id,
			prompt: `Repair the failed release for the original approved task. The application was safely restored to ${restoredSha}. Failure: ${reason}. Start from the current default branch and preserve the approved acceptance criteria. This is a new attempt, not a resumed model session.\n\n${issue.title}\n${issue.description}`,
		});
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: {
				state: "dispatched",
				runId: spawned.runId,
				startedAt: input.now().toISOString(),
				failureReason: null,
				endedAt: null,
			},
		});
		await input.emit(spawned.runId, "plan_run.deployment_repair", {
			planRunId: planRun.id,
			seq: child.seq,
			previousRunId: run.id,
			restoredSha,
			reason,
		});
		return { kind: "result", result: { kind: "dispatched", childRunId: spawned.runId } };
	} catch (error) {
		if (error instanceof PlanRunSpawnDeferredError)
			return { kind: "result", result: { kind: "noop", reason: error.message } };
		const detail = `release_repair_stopped:${formatError(error)}`;
		await repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: child.seq,
			patch: { state: "failed", failureReason: detail, endedAt: input.now().toISOString() },
		});
		await repos.planRuns.transitionTo(planRun.id, "failed", {
			failureReason: detail,
			endedAt: input.now().toISOString(),
		});
		await input.emit(run.id, "plan_run.failed", {
			planRunId: planRun.id,
			failedSeq: child.seq,
			reason: detail,
		});
		return {
			kind: "result",
			result: { kind: "plan_failed", failedSeq: child.seq, reason: detail },
		};
	}
}
