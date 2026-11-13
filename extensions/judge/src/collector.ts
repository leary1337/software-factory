

import { listRuns, type WarrenClient } from "./client.ts";
import type { JudgmentCursorStore } from "./cursor-store.ts";
import type { JudgeOutcome } from "./judge-loop.ts";
import type { VerdictStore } from "./verdict-store.ts";
import { type RunListRow, isTerminalRunState } from "./warren-wire.ts";


export type JudgeFn = (runId: string, opts: { }) => Promise<JudgeOutcome>;

export interface JudgeCollectorDeps {
	readonly client: WarrenClient;
	readonly verdicts: VerdictStore;
	readonly cursors: JudgmentCursorStore;
	readonly judge: JudgeFn;
	readonly rubricVersion: string;
	readonly judgeModelId: string;
	/** Runs fetched per discovery page (server caps at 500). */
	readonly runsPageSize?: number;
	/** Injectable clock for checkpoints. */
	readonly now?: () => Date;
	/** Per-run failures land here; the cycle continues with the next run. */
	readonly onRunError?: (runId: string, err: unknown) => void;
	/** After every accepted judgment — the operator's visibility feed. */
	readonly onJudgment?: (runId: string, outcome: JudgeOutcome) => void;
}

export interface JudgeCycleStats {
	readonly runsDiscovered: number;
	readonly terminalRuns: number;
	readonly judged: number;
	readonly alreadyJudged: number;
}

const DEFAULT_RUNS_PAGE_SIZE = 500;

/**
 * Discover every run by paging the full list from offset 0. FRICTION §1:
 * no "changed since" parameter exists, so this is a full re-list every
 * cycle. Re-seeing a row is harmless — the cursor gate and the store's
 * dedupe key both absorb it.
 */
async function discoverRuns(client: WarrenClient, pageSize: number): Promise<RunListRow[]> {
	const runs: RunListRow[] = [];
	let offset = 0;
	while (true) {
		const page = await listRuns(client, { limit: pageSize, offset });
		runs.push(...page.runs);
		if (page.runs.length < pageSize) return runs;
		offset += page.runs.length;
	}
}

/** Store a judgment before advancing its cursor. Provider errors remain retryable. */
async function judgeOneRun(
	runId: string,
	deps: JudgeCollectorDeps,
	now: () => Date,
): Promise<boolean> {
	const outcome = await deps.judge(runId, {});
	if (outcome.kind === "unjudged" && outcome.reason === "judge_error") return false;

	if (outcome.kind === "verdict") {
		deps.verdicts.recordVerdict(outcome.verdict);
	} else {
		deps.verdicts.recordUnjudged({
			runId,
			rubricVersion: deps.rubricVersion,
			judgeModelId: deps.judgeModelId,
			reason: outcome.reason,
			detail: outcome.detail,
		});
	}
	// Checkpoint ONLY after the store accepted (audit-log discipline).
	deps.cursors.checkpoint(runId, {
		rubricVersion: deps.rubricVersion,
		judgeModelId: deps.judgeModelId,
		outcome: outcome.kind,
		updatedAt: now().toISOString(),
	});
	deps.onJudgment?.(runId, outcome);
 return true;

}

/** One full poll cycle: discover, then judge every newly-terminal run. */
export async function collectOnce(deps: JudgeCollectorDeps): Promise<JudgeCycleStats> {
	const now = deps.now ?? (() => new Date());
	const runs = await discoverRuns(deps.client, deps.runsPageSize ?? DEFAULT_RUNS_PAGE_SIZE);
	// Oldest first: a backlog drains in completion order.
	const terminal = runs
		.filter((r) => isTerminalRunState(r.state))
		.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

	let judged = 0;
	let alreadyJudged = 0;
	for (const run of terminal) {
		if (!deps.cursors.needsJudgment(run.id, deps.rubricVersion, deps.judgeModelId)) {
			alreadyJudged += 1;
			continue;
		}
		try {
			if (await judgeOneRun(run.id, deps, now)) judged += 1;
		} catch (err) {
			// Per-run isolation: one failing judgment (warren unreachable,
			// wire drift, store error) must not starve the others. The
			// cursor did not advance, so the next cycle retries this run.
			deps.onRunError?.(run.id, err);
		}
	}
	return {
		runsDiscovered: runs.length,
		terminalRuns: terminal.length,
		judged,
		alreadyJudged,
	};
}

export interface RunJudgeCollectorOptions extends JudgeCollectorDeps {
	readonly pollIntervalMs: number;
	readonly signal?: AbortSignal;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Cycle-level failures (discovery unreachable) land here. */
	readonly onCycleError?: (err: unknown) => void;
	/** After every completed cycle — the health surface's liveness feed. */
	readonly onCycle?: (stats: JudgeCycleStats) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The collector loop: cycle, sleep, repeat until the signal aborts.
 * Graceful shutdown: the loop only observes the abort BETWEEN cycles, and
 * `collectOnce` awaits each judgment to completion, so SIGTERM/SIGINT
 * always lets the in-flight judgment finish and checkpoint before exit.
 */
export async function runJudgeCollector(opts: RunJudgeCollectorOptions): Promise<void> {
	const sleep = opts.sleep ?? defaultSleep;
	while (opts.signal?.aborted !== true) {
		try {
			const stats = await collectOnce(opts);
			opts.onCycle?.(stats);
		} catch (err) {
			opts.onCycleError?.(err);
		}
		await sleep(opts.pollIntervalMs);
	}
}
