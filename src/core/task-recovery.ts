import {
	productionVerificationFromEvent,
	verifiedReleaseChecks,
} from "./production-verification.ts";
import type { PreparationRecoveryState, RollbackRecoveryState } from "./wire-recovery.ts";

export interface PreparationRecovery {
	state: PreparationRecoveryState;
	attempt: number;
	reason: string;
	action: string;
	nextAction: string;
	stopReason?: string;
}
export interface RollbackRecovery {
	state: RollbackRecoveryState;
	sha: string | null;
	reason: string;
}
export interface TaskRecoverySummary {
	preparation: PreparationRecovery | null;
	rollback: RollbackRecovery | null;
}
export interface RecoveryEvent {
	kind: string;
	ts: string;
	payload: unknown;
}
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : fallback;
}
function sha(value: unknown): string | null {
	return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value : null;
}
function preparationRecovery(
	previous: PreparationRecovery | null,
	event: RecoveryEvent,
): PreparationRecovery | null {
	const data = record(event.payload);
	switch (event.kind) {
		case "preparation.repair_started":
			return {
				state: "repairing",
				attempt: (previous?.attempt ?? 0) + 1,
				reason: text(data.reason, "Dependency preparation failed temporarily."),
				action: text(data.action, "Retry the dependency command while preserving source changes."),
				nextAction: "Wait for dependency preparation to finish.",
			};
		case "preparation.repair_stopped":
			return {
				state: "stopped",
				attempt: previous?.attempt ?? 0,
				reason: previous?.reason ?? text(data.reason, "Environment repair could not start."),
				stopReason: text(data.reason, "Automatic repair stopped."),
				action: previous?.action ?? "No automatic repair was started.",
				nextAction: "Fix the environment or review the approved task limits before resuming.",
			};
		case "preparation.failed":
			if (previous?.state === "stopped" && data.message === previous.stopReason) return previous;
			return {
				state: "failed",
				attempt: previous?.attempt ?? 0,
				reason: text(data.message, "Environment preparation failed."),
				action: previous?.action ?? "No automatic repair was started.",
				nextAction:
					"Check the project preparation settings and resolve the failing dependency step before retrying.",
			};
		case "preparation.completed":
			return previous
				? {
						...previous,
						state: "recovered",
						stopReason: undefined,
						nextAction: "Environment preparation passed; execution can continue.",
					}
				: null;
		default:
			return previous;
	}
}
function rollbackRecovery(
	previous: RollbackRecovery | null,
	event: RecoveryEvent,
): RollbackRecovery | null {
	const data = record(event.payload);
	switch (event.kind) {
		case "plan_run.rollback_attempt":
			return {
				state: "running",
				sha: sha(data.expectedSha),
				reason: text(data.reason, "The new release did not pass verification."),
			};
		case "plan_run.rollback_failed":
			return {
				state: "failed",
				sha: previous?.sha ?? null,
				reason: text(data.reason, "Rollback verification failed."),
			};
		case "plan_run.rollback_verified":
			return verifiedReleaseChecks(data, event.ts) &&
				(!previous?.sha || previous.sha === sha(data.expectedSha))
				? {
						state: "verified",
						sha: sha(data.expectedSha),
						reason: text(
							data.reason,
							previous?.reason ?? "The new release did not pass verification.",
						),
					}
				: {
						state: "failed",
						sha: previous?.sha ?? null,
						reason: "Rollback verification evidence is incomplete.",
					};
		case "plan_run.deployment_verified":
			return previous &&
				productionVerificationFromEvent({
					kind: event.kind,
					payloadJson: event.payload,
					ts: event.ts,
				})
				? { ...previous, state: "released" }
				: previous;
		default:
			return previous;
	}
}
/** Consume persisted events in time/sequence order; no inferred success from process exit. */
export function projectTaskRecovery(events: readonly RecoveryEvent[]): TaskRecoverySummary {
	let preparation: PreparationRecovery | null = null;
	let rollback: RollbackRecovery | null = null;
	for (const event of events) {
		preparation = preparationRecovery(preparation, event);
		rollback = rollbackRecovery(rollback, event);
	}
	return { preparation, rollback };
}
