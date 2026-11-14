/**
 * Correlates runtime finalization callbacks within the server process.
 * A caller registers an intent; the HTTP callback resolves its result promise.
 * Entries are ephemeral: the caller owns timeout/recovery and removes its entry.
 * Attempt ids prevent stale deliveries from settling a newer attempt.
 */

import { generateId } from "../../core/ids.ts";
import type { FinalizeResult } from "../contract.ts";
import type { FinalizeCallbackIntent } from "./wire.ts";

/** Outcome of a `submit` — the endpoint maps every case onto an idempotent 200. */
export type FinalizeSubmitOutcome = "accepted" | "duplicate" | "stale" | "unknown";

/** Handle `register` hands back to `finalize()`. */
export interface PendingFinalize {
	/** The attempt id embedded in the served intent + expected on the result POST. */
	readonly attemptId: string;
	/**
	 * Resolves when the runtime harness POSTs its result (via `submit`). Never
	 * rejects — `finalize()` owns the timeout/runtime-exit races and calls `abort`.
	 */
	readonly result: Promise<FinalizeResult>;
}

interface Entry {
	attemptId: string;
	intent: FinalizeCallbackIntent;
	resolve: (r: FinalizeResult) => void;
	settled: boolean;
}

export class FinalizeCoordinator {
	private readonly byRun = new Map<string, Entry>();

	/**
	 * Park a pending finalize for `runId` and return the awaitable result. Stamps
	 * a fresh `attemptId` INTO the stored intent (the served copy carries it) so
	 * the result POST correlates. If a stale entry already exists for the run
	 * (a prior finalize that never settled), it is dropped — the newest attempt
	 * wins, and the old awaiter is left to its own timeout.
	 */
	register(runId: string, intent: Omit<FinalizeCallbackIntent, "attemptId">): PendingFinalize {
		const attemptId = generateId("finalizeAttempt");
		const fullIntent: FinalizeCallbackIntent = { ...intent, attemptId };
		let resolve!: (r: FinalizeResult) => void;
		const result = new Promise<FinalizeResult>((res) => {
			resolve = res;
		});
		this.byRun.set(runId, { attemptId, intent: fullIntent, resolve, settled: false });
		return { attemptId, result };
	}

	/**
	 * The parked intent for `runId`, or `undefined` when none is pending (or it
	 * already settled). Served by `GET /runs/:id/finalize-intent` to the polling
	 * harness.
	 */
	peekIntent(runId: string): FinalizeCallbackIntent | undefined {
		const entry = this.byRun.get(runId);
		return entry !== undefined && !entry.settled ? entry.intent : undefined;
	}

	/**
	 * Deliver a result for `runId`. Requires an exact `attemptId` match (`"stale"`
	 * otherwise). First matching delivery resolves the parked promise
	 * (`"accepted"`); a repeat is a redelivery no-op (`"duplicate"`); no entry is
	 * `"unknown"`. Every case is safe for the endpoint to 200.
	 */
	submit(runId: string, attemptId: string, result: FinalizeResult): FinalizeSubmitOutcome {
		const entry = this.byRun.get(runId);
		if (entry === undefined) return "unknown";
		if (entry.attemptId !== attemptId) return "stale";
		if (entry.settled) return "duplicate";
		entry.settled = true;
		entry.resolve(result);
		return "accepted";
	}

	/**
	 * Drop the pending entry for `runId` — called by `finalize()` after it
	 * resolves, times out, or detects the runtime is gone, so a late POST for a dead
	 * attempt is a clean `"unknown"`. Idempotent. Only removes the entry when its
	 * `attemptId` matches, so aborting a stale attempt can't evict a newer one.
	 */
	abort(runId: string, attemptId: string): void {
		const entry = this.byRun.get(runId);
		if (entry !== undefined && entry.attemptId === attemptId) this.byRun.delete(runId);
	}

	/** Count of live pending entries — test/observability helper. */
	get pendingCount(): number {
		return this.byRun.size;
	}
}

/** Shared by runtime callers and HTTP callbacks; tests may inject a private instance. */
export const sharedFinalizeCoordinator = new FinalizeCoordinator();
