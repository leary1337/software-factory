import type { RuntimeId } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { RunEventBroker } from "../events.ts";
import type { BridgeLogger, CancelBurrowRunFn, StreamEventView } from "./types.ts";

/* --- Config --- */

/**
 * Default in-turn stall budget: 10 minutes — well below the watchdog's
 * 45-minute heartbeat, yet above any legitimate silent stretch inside one
 * model turn. `WARREN_TURN_STALL_MS`; `0` disables stall detection.
 */
export const DEFAULT_TURN_STALL_MS = 600_000;

/**
 * Default degeneration thresholds (warren-74a7): 200 consecutive
 * whitespace-only deltas (or 8 KiB of them) is far past anything a healthy
 * stream produces before the provider's length cap ends the turn.
 * `WARREN_TURN_DEGENERATE_MIN_DELTAS` / `..._MIN_BYTES`; `0` disables.
 */
export const DEFAULT_TURN_DEGENERATE_MIN_DELTAS = 200;
export const DEFAULT_TURN_DEGENERATE_MIN_BYTES = 8_192;

/** Stall-timer cadence: an integer compare per tick, so 15s is free. */
export const DEFAULT_TURN_STALL_CHECK_INTERVAL_MS = 15_000;

interface TurnEnvLike {
	readonly [key: string]: string | undefined;
}

export interface TurnMonitorOptions {
	/** Stall budget in ms. */
	readonly stallMs: number | null;
	/** Whitespace-delta count threshold. */
	readonly degenerateMinDeltas: number | null;
	/** Whitespace-byte threshold. */
	readonly degenerateMinBytes: number | null;
	/** Stall-timer cadence in ms. */
	readonly stallCheckIntervalMs: number;
	/** Injected clock (tests). */
	readonly clock: TurnClock;
}

export function turnMonitorOptionsFromEnv(
	env: TurnEnvLike,
	clock: TurnClock = wallClock,
): TurnMonitorOptions {
	return {
		stallMs: parseNonNegativeInt(
			env.WARREN_TURN_STALL_MS,
			"WARREN_TURN_STALL_MS",
			DEFAULT_TURN_STALL_MS,
		),
		degenerateMinDeltas: parseNonNegativeInt(
			env.WARREN_TURN_DEGENERATE_MIN_DELTAS,
			"WARREN_TURN_DEGENERATE_MIN_DELTAS",
			DEFAULT_TURN_DEGENERATE_MIN_DELTAS,
		),
		degenerateMinBytes: parseNonNegativeInt(
			env.WARREN_TURN_DEGENERATE_MIN_BYTES,
			"WARREN_TURN_DEGENERATE_MIN_BYTES",
			DEFAULT_TURN_DEGENERATE_MIN_BYTES,
		),
		stallCheckIntervalMs: DEFAULT_TURN_STALL_CHECK_INTERVAL_MS,
		clock,
	};
}

function parseNonNegativeInt(
	raw: string | undefined,
	name: string,
	fallback: number,
): number | null {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
		throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
	}
	return parsed === 0 ? null : parsed;
}

/** Wall clock — the production `TurnClock`. */
export const wallClock: TurnClock = { now: () => Date.now() };

export interface TurnClock {
	now(): number;
}

/* --- The monitor --- */

/** What tripped: drives the emitted event kind, payload, and cancel reason. */
export type TurnTrip =
	| { readonly kind: "stalled"; readonly idleMs: number; readonly stallMs: number }
	| {
			readonly kind: "degenerate";
			readonly deltaCount: number;
			readonly byteCount: number;
	  };

export class TurnMonitor {
	readonly #options: TurnMonitorOptions;
	#timer: ReturnType<typeof setInterval> | null = null;
	#lastEventAtMs: number | null = null;
	#turnActive = false;
	#whitespaceDeltas = 0;
	#whitespaceBytes = 0;

	constructor(options: TurnMonitorOptions) {
		this.#options = options;
	}

	/**
	 * Observe one stream event (the bridge feeds every envelope it sees,
	 * before the per-delta noise drop) and return the trip when a threshold
	 * crossed. Any observed event re-anchors the stall clock.
	 */
	observe(event: StreamEventView): TurnTrip | null {
		const now = this.#options.clock.now();
		this.#lastEventAtMs = now;
		const env = asRecord(event.payload);
		if (env === null) return null;
		const type = env.type;
		if (typeof type !== "string") return null;
		if (type === "turn_start") {
			this.#turnActive = true;
			this.#resetTurnCounters();
		} else if (type === "turn_end") {
			this.#turnActive = false;
			this.#resetTurnCounters();
		} else if (type === "agent_end") {
			this.#turnActive = false;
			this.#resetTurnCounters();
		} else if (type === "message_update") {
			const trip = this.#observeMessageUpdate(env);
			if (trip !== null) return trip;
		}
		return null;
	}

	/**
	 * Arm the periodic stall check. `onStall` fires at most once (the timer
	 * disarms itself before invoking). No-op when stall detection is disabled;
	 * the bridge MUST call `stop()` when its loop ends.
	 */
	start(onStall: (trip: TurnTrip) => void): void {
		this.stop();
		if (this.#options.stallMs === null) return;
		this.#timer = setInterval(() => {
			const trip = this.#checkStall();
			if (trip !== null) {
				this.stop();
				onStall(trip);
			}
		}, this.#options.stallCheckIntervalMs);
	}

	stop(): void {
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	#checkStall(): TurnTrip | null {
		const stallMs = this.#options.stallMs;
		if (stallMs === null || !this.#turnActive || this.#lastEventAtMs === null) return null;
		const idleMs = this.#options.clock.now() - this.#lastEventAtMs;
		if (idleMs <= stallMs) return null;
		return { kind: "stalled", idleMs, stallMs };
	}

	#resetTurnCounters(): void {
		this.#whitespaceDeltas = 0;
		this.#whitespaceBytes = 0;
	}

	/**
	 * Inspect a `message_update` envelope. Empty deltas are legitimate wire
	 * noise (pi's parser drops only empty TEXT; the whitespace-only spiral is
	 * what slips through), so only non-empty whitespace counts against the
	 * degeneration thresholds; any content-bearing delta resets the streak.
	 */
	#observeMessageUpdate(env: Record<string, unknown>): TurnTrip | null {
		const ame = asRecord(env.assistantMessageEvent);
		if (ame === null) return null;
		const deltaType = ame.type;
		if (deltaType !== "thinking_delta" && deltaType !== "text_delta") return null;
		const delta = ame.delta;
		if (typeof delta !== "string") return null;
		if (delta.length === 0 || delta.trim() !== "") {
			this.#resetTurnCounters();
			return null;
		}
		this.#whitespaceDeltas += 1;
		this.#whitespaceBytes += delta.length;
		if (this.#degenerate()) {
			return {
				kind: "degenerate",
				deltaCount: this.#whitespaceDeltas,
				byteCount: this.#whitespaceBytes,
			};
		}
		return null;
	}

	#degenerate(): boolean {
		const { degenerateMinDeltas, degenerateMinBytes } = this.#options;
		if (degenerateMinDeltas !== null && this.#whitespaceDeltas >= degenerateMinDeltas) return true;
		return degenerateMinBytes !== null && this.#whitespaceBytes >= degenerateMinBytes;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/* --- Trip action --- */

export interface TurnTripActionInput {
	readonly runId: string;
	readonly sandboxRunId: string;
	readonly trip: TurnTrip;

	readonly runtime: RuntimeId | null;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	readonly logger?: BridgeLogger;
}

export async function tripTurnMonitor(input: TurnTripActionInput): Promise<void> {
	input.logger?.warn?.(
		{ runId: input.runId, sandboxRunId: input.sandboxRunId, trip: input.trip },
		"turn monitor tripped; cancelling run",
	);
	await emitTripEvent(input);
	try {
		await input.cancelBurrowRun(tripReason(input.trip));
	} catch (err) {
		input.logger?.error?.(
			{
				runId: input.runId,
				sandboxRunId: input.sandboxRunId,
				err: err instanceof Error ? err.message : String(err),
			},
			"turn-monitor burrow cancel failed; reap will finalize from terminal-detect",
		);
	}
}

async function emitTripEvent(input: TurnTripActionInput): Promise<void> {
	try {
		const seq = ((await input.repos.events.maxSeqForRun(input.runId)) ?? 0) + 1;
		const row = await input.repos.events.append({
			runId: input.runId,
			sandboxEventSeq: seq,
			ts: new Date().toISOString(),
			kind: tripEventKind(input.trip),
			stream: "system",
			payload: tripEventPayload(input.trip),
		});
		input.broker.publish(input.runId, row);
	} catch (err) {
		input.logger?.error?.(
			{ runId: input.runId, err: err instanceof Error ? err.message : String(err) },
			"failed to emit turn-monitor trip event",
		);
	}
}

function tripEventKind(trip: TurnTrip): string {
	if (trip.kind === "stalled") return "turn.stalled";
	return "turn.degenerate";
}

function tripEventPayload(trip: TurnTrip): Record<string, unknown> {
	if (trip.kind === "stalled") {
		return { idleMs: trip.idleMs, stallMs: trip.stallMs };
	}
	return { deltaCount: trip.deltaCount, byteCount: trip.byteCount };
}

function tripReason(trip: TurnTrip): string {
	if (trip.kind === "stalled") {
		return `turn stalled: no events for ${trip.idleMs}ms (budget ${trip.stallMs}ms)`;
	}
	return `degenerate turn: ${trip.deltaCount} whitespace-only deltas (${trip.byteCount} bytes)`;
}

/* --- Bridge wiring --- */

export interface BridgeTurnMonitorInput {
	readonly monitor: TurnMonitor;
	readonly runId: string;
	readonly sandboxRunId: string;

	readonly runtime: RuntimeId | null;
	readonly repos: Repos;
	readonly broker: RunEventBroker;
	readonly cancelBurrowRun: CancelBurrowRunFn;
	/** The bridge's abort controller — the trip aborts the parked source iterator. */
	readonly ctrl: AbortController;
	/** Marks the bridge's terminal outcome (`cancelled`) on a trip. */
	onTerminalCancelled: () => void;
	readonly logger?: BridgeLogger;
}

export interface BridgeTurnMonitor {
	/** Feed one event; returns the trip when a threshold crossed, else `null`. */
	readonly observe: (event: StreamEventView) => TurnTrip | null;
	/** Act on a trip: persist + emit + cancel, then abort the source. */
	readonly trip: (trip: TurnTrip) => Promise<void>;
	/** True once a trip acted (the bridge's catch treats abort as terminal). */
	readonly tripped: { readonly value: boolean };
	readonly stop: () => void;
}

/**
 * Wire a monitor into one bridge run (#1242): arms the stall timer and returns
 * the observe/trip/stop surface the bridge loop uses. Lives here — not in
 * `bridge.ts` — so the bridge stays inside its file-size ratchet.
 */
export function bridgeTurnMonitor(input: BridgeTurnMonitorInput): BridgeTurnMonitor {
	const tripped = { value: false };
	const trip = async (turnTrip: TurnTrip): Promise<void> => {
		tripped.value = true;
		input.onTerminalCancelled();
		await tripTurnMonitor({
			runId: input.runId,
			sandboxRunId: input.sandboxRunId,
			trip: turnTrip,
			runtime: input.runtime,
			repos: input.repos,
			broker: input.broker,
			cancelBurrowRun: input.cancelBurrowRun,
			...(input.logger !== undefined ? { logger: input.logger } : {}),
		});
		input.ctrl.abort();
	};
	input.monitor.start((turnTrip) => {
		if (input.ctrl.signal.aborted) return;
		void trip(turnTrip);
	});
	return {
		observe: (event) => input.monitor.observe(event),
		trip,
		tripped,
		stop: () => input.monitor.stop(),
	};
}
