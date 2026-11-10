/**
 * Plan-run cancellation orchestration (warren-e240 / pl-882c step 8).
 *
 * Moved out of `src/server/handlers/plan-runs.ts`: flip the plan-run to
 * `cancelled` and, if a child run is in-flight (dispatched / running /
 * pr_open), forward a cancel to that child via the existing `cancelRun`
 * seam. Repeated cancellation retries any linked run still alive; succeeded
 * and failed plans remain terminal.
 */

import { isTerminalRunState } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import {
	type AutoOpenPrConfig,
	type CancelReap,
	cancelRun,
	type RunEventBroker,
} from "../runs/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { withPlanRunLock } from "./lock.ts";

/** Minimal logger shape — structurally satisfied by the server's pino-shaped Logger. */
export interface CancelPlanRunLogger {
	warn(obj: object, msg?: string): void;
}

export interface CancelPlanRunInput {
	readonly planRunId: string;
	readonly repos: Repos;
	readonly broker?: RunEventBroker;
	/** Runtime-provider + inline-reap seams `cancelRun` needs (warren-b223). */
	readonly runtimeProvider: RuntimeProvider;
	readonly reap?: CancelReap;
	readonly autoOpenPr?: AutoOpenPrConfig;
	readonly logger?: CancelPlanRunLogger;
	readonly now?: () => Date;
}

export interface CancelPlanRunResult {
	readonly planRun: PlanRunRow;
	readonly cancelledChild: { childSeq: number; runId: string } | null;
	readonly alreadyTerminal: boolean;
}

export async function cancelPlanRun(input: CancelPlanRunInput): Promise<CancelPlanRunResult> {
	return withPlanRunLock(input.planRunId, () => cancelLocked(input));
}

async function cancelLocked(input: CancelPlanRunInput): Promise<CancelPlanRunResult> {
	const planRun = await input.repos.planRuns.require(input.planRunId);
	if (planRun.state === "succeeded" || planRun.state === "failed") {
		return { planRun, cancelledChild: null, alreadyTerminal: true };
	}

	const children = await input.repos.planRuns.listChildren(planRun.id);
	const inFlight = children.find(
		(c) => c.state === "dispatched" || c.state === "running" || c.state === "pr_open",
	);

	const endedAt = (input.now?.() ?? new Date()).toISOString();
	const alreadyTerminal = planRun.state === "cancelled";
	const cancelled = alreadyTerminal
		? planRun
		: await input.repos.planRuns.transitionTo(planRun.id, "cancelled", { endedAt });

	const cancelledChild = await cancelInFlightChild(input, planRun.id, inFlight);
	return { planRun: cancelled, cancelledChild, alreadyTerminal };
}

/**
 * Best-effort forward-cancel of the in-flight child run. The plan-run
 * itself is already in the cancelled state, and the child run will land
 * terminally via the bridge regardless, so a failure here degrades to a
 * warning on the result rather than a rejected cancel.
 */
async function cancelInFlightChild(
	input: CancelPlanRunInput,
	planRunId: string,
	inFlight: { seq: number; runId: string | null } | undefined,
): Promise<{ childSeq: number; runId: string } | null> {
	if (inFlight === undefined || inFlight.runId === null) return null;
	const events = await input.repos.events.listByRun(inFlight.runId);
	const stepIds = events
		.filter((e) => e.kind === "plan_run.review_step")
		.map((e) => (e.payloadJson as { stepRunId?: unknown }).stepRunId)
		.filter((id): id is string => typeof id === "string");
	let cancelled: { childSeq: number; runId: string } | null = null;
	for (const runId of new Set([...stepIds.reverse(), inFlight.runId])) {
		const run = await input.repos.runs.get(runId);
		if (!run || isTerminalRunState(run.state)) continue;
		const result = await cancelLinkedRun(input, planRunId, inFlight.seq, runId);
		cancelled ??= result;
	}
	return cancelled;
}

async function cancelLinkedRun(
	input: CancelPlanRunInput,
	planRunId: string,
	seq: number,
	runId: string,
): Promise<{ childSeq: number; runId: string } | null> {
	try {
		await cancelRun({
			runId,
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			...(input.reap !== undefined ? { reap: input.reap } : {}),
			...(input.broker !== undefined ? { broker: input.broker } : {}),
			reason: `plan_run_cancelled:${planRunId}`,
			...(input.now !== undefined ? { now: input.now } : {}),
			...(input.autoOpenPr !== undefined ? { autoOpenPr: input.autoOpenPr } : {}),
		});
		return { childSeq: seq, runId };
	} catch (err) {
		// Surface the failure via the log so operators can see why the
		// child didn't cancel cleanly.
		input.logger?.warn(
			{
				planRunId,
				childRunId: runId,
				err: err instanceof Error ? err.message : String(err),
			},
			"plan_run.cancel_child_failed",
		);
		return null;
	}
}
