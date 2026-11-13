import type { RuntimeId } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { SessionStatsAccumulator } from "../usage-aggregate.ts";
import type { BridgeLogger, PiStatsClient, SessionStats } from "./types.ts";

/**
 * Snapshot pi's get_session_stats RPC, swallowing failures (transport
 * error, channel closed, agent isn't pi). The `phase` tag lands in the
 * log message so operators can tell baseline-failed from terminal-failed.
 */
export async function snapshotStats(
	client: PiStatsClient,
	sandboxRunId: string,
	signal: AbortSignal,
	phase: "baseline" | "terminal",
	runId: string,
	logger: BridgeLogger | undefined,
): Promise<SessionStats | null> {
	try {
		return await client.fetch(sandboxRunId, signal);
	} catch (err) {
		logger?.warn?.(
			{
				runId,
				sandboxRunId,
				phase,
				err: err instanceof Error ? err.message : String(err),
			},
			"pi get_session_stats failed; token columns will stay null",
		);
		return null;
	}
}

export interface PersistPiStatsInput {
	readonly piStats: PiStatsClient;
	readonly sandboxRunId: string;
	readonly runId: string;
	readonly repos: Repos;
	readonly baseline: Promise<SessionStats | null> | undefined;
	readonly signal: AbortSignal;
	readonly logger?: BridgeLogger;
}

/**
 * Compute (terminal − baseline) and persist via `RunsRepo.attachStats`.
 * Resolved pi sessions reuse prior turns via `--continue`/`--session`, so
 * `get_session_stats` always returns the session-cumulative number. The
 * delta is the only safe per-run accounting (plan risk #3). If the
 * baseline was missing (RPC failed at start), the delta defaults to the
 * terminal value verbatim — better to over-attribute than under-report.
 * Terminal failure leaves the row untouched.
 */
export async function persistPiStatsDelta(input: PersistPiStatsInput): Promise<void> {
	const terminal = await snapshotStats(
		input.piStats,
		input.sandboxRunId,
		input.signal,
		"terminal",
		input.runId,
		input.logger,
	);
	if (terminal === null) return;
	const baseline = input.baseline !== undefined ? await input.baseline : null;
	const base: SessionStats = baseline ?? {
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
	const delta = {
		tokensInput: terminal.tokensInput - base.tokensInput,
		tokensOutput: terminal.tokensOutput - base.tokensOutput,
		tokensCacheRead: terminal.tokensCacheRead - base.tokensCacheRead,
		tokensCacheWrite: terminal.tokensCacheWrite - base.tokensCacheWrite,
	};
	try {
		await input.repos.runs.attachStats(input.runId, delta);
		input.logger?.info?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				tokensInput: delta.tokensInput,
				tokensOutput: delta.tokensOutput,
			},
			"persisted pi session-stats delta",
		);
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"attachStats threw; token columns may be inconsistent",
		);
	}
}

export interface PersistInStreamUsageInput {
	readonly usage: SessionStatsAccumulator;
	readonly runtime?: RuntimeId;
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly repos: Repos;
	readonly logger?: BridgeLogger;
}

export async function persistInStreamUsage(input: PersistInStreamUsageInput): Promise<void> {
	if (!input.usage.seen) return;
	try {
		await input.repos.runs.attachStats(input.runId, {
			tokensInput: input.usage.tokensInput,
			tokensOutput: input.usage.tokensOutput,
			tokensCacheRead: input.usage.tokensCacheRead,
			tokensCacheWrite: input.usage.tokensCacheWrite,
		});
		input.logger?.info?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				runtime: input.runtime,
				tokensInput: input.usage.tokensInput,
				tokensOutput: input.usage.tokensOutput,
			},
			"persisted in-stream usage totals",
		);
	} catch (err) {
		input.logger?.warn?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				runtime: input.runtime,
				err: err instanceof Error ? err.message : String(err),
			},
			"attachStats threw on in-stream usage; token columns may stay null",
		);
	}
}

export async function persistObservedUsage(input: {
	runId: string;
	sandboxRunId: string;
	piUsage: SessionStatsAccumulator;
	claudeUsage: SessionStatsAccumulator;
	repos: Repos;
	logger?: BridgeLogger;
}): Promise<void> {
	const usage = input.piUsage.seen ? input.piUsage : input.claudeUsage;
	await persistInStreamUsage({
		usage,
		...(usage.runtime ? { runtime: usage.runtime } : {}),
		runId: input.runId,
		sandboxRunId: input.sandboxRunId,
		repos: input.repos,
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});
}
