import { extractAgentEventEnvelope } from "../core/event-envelope.ts";
import { type UsageReading, type UsageShape, usageShapeFor } from "../core/usage-shape.ts";
import { isKnownRuntimeId, type RuntimeId } from "../core/wire.ts";
import type { SessionStats } from "./stream/index.ts";

/**
 * Structural subset of `RunEvent` (burrow stream) and `EventRow`
 * (warren events table) shared by every usage shape we sniff. Both
 * sources only carry `kind`, `stream`, `payload` for the purposes of
 * usage extraction; the rest of the row (`seq`, `ts`, `id`, …) is
 * irrelevant. Structural typing lets the bridge feed `RunEvent` and
 * the read-time hydrator feed `EventRow` (mapped through
 * `eventRowToUsageInput`) into the same accumulator without an
 * adapter.
 */
export interface UsageEventInput {
	readonly kind: string;
	readonly stream: string | null;
	/**
	 * Parse-boundary provenance (warren-6646). Optional — the persisted
	 * events table predates the tag; absent reads as warren-authored.
	 * Fed into the shared envelope extractor's provenance gate
	 * (warren-27b5).
	 */
	readonly origin?: string;
	readonly payload: unknown;
}

export interface SessionStatsAccumulator {
	seen: boolean;
	runtime?: RuntimeId;
	tokensInput: number;
	tokensOutput: number;
	tokensCacheRead: number;
	tokensCacheWrite: number;
}

export function newSessionStatsAccumulator(): SessionStatsAccumulator {
	return {
		seen: false,
		tokensInput: 0,
		tokensOutput: 0,
		tokensCacheRead: 0,
		tokensCacheWrite: 0,
	};
}

/**
 * Fold one shape reading into the accumulator per the shape's declared
 * mode. `sum` (pi) adds only the non-null fields — a partial turn_end
 * still contributes what it carried. `assign` (claude-code) overwrites
 * with a zero fallback, because claude's terminal `result` envelope is
 * cumulative and complete.
 */
function applyReading(
	acc: SessionStatsAccumulator,
	reading: UsageReading,
	mode: UsageShape["mode"],
): void {
	acc.seen = true;
	if (mode === "assign") {
		acc.tokensInput = reading.tokensInput ?? 0;
		acc.tokensOutput = reading.tokensOutput ?? 0;
		acc.tokensCacheRead = reading.tokensCacheRead ?? 0;
		acc.tokensCacheWrite = reading.tokensCacheWrite ?? 0;
		return;
	}
	if (reading.tokensInput !== null) acc.tokensInput += reading.tokensInput;
	if (reading.tokensOutput !== null) acc.tokensOutput += reading.tokensOutput;
	if (reading.tokensCacheRead !== null) acc.tokensCacheRead += reading.tokensCacheRead;
	if (reading.tokensCacheWrite !== null) acc.tokensCacheWrite += reading.tokensCacheWrite;
}

function accumulateWithShape(
	acc: SessionStatsAccumulator,
	event: UsageEventInput,
	runtime: RuntimeId,
): void {
	const envelope = extractAgentEventEnvelope(event);
	if (envelope === null) return;
	const shape = usageShapeFor(runtime);
	if (shape === null || envelope.type !== shape.envelopeType) return;
	const reading = shape.read(envelope.payload);
	if (reading === null) return;
	applyReading(acc, reading, shape.mode);
	if (isKnownRuntimeId(envelope.payload.runtime)) acc.runtime = envelope.payload.runtime;
}

export function accumulatePiUsage(acc: SessionStatsAccumulator, event: UsageEventInput): void {
	accumulateWithShape(acc, event, "pi");
}

export function extractClaudeUsage(acc: SessionStatsAccumulator, event: UsageEventInput): void {
	accumulateWithShape(acc, event, "claude-code");
}

/**
 * Aggregate `pi` and `claude-code` usage envelopes across a run's
 * persisted event stream and return the cumulative session totals, or
 * `null` if nothing usage-shaped was observed.
 *
 * Pi-wins parity (mirrors the bridge's terminal write at stream.ts:297):
 * when a stream carries both shapes, pi's accumulator is the answer.
 * That's mostly defensive — in practice a single run is one runtime —
 * but it keeps the contract aligned with what the bridge would have
 * checkpointed had it lived long enough.
 */
export function aggregateUsageFromEvents(events: Iterable<UsageEventInput>): SessionStats | null {
	const piAcc = newSessionStatsAccumulator();
	const claudeAcc = newSessionStatsAccumulator();
	for (const event of events) {
		accumulatePiUsage(piAcc, event);
		extractClaudeUsage(claudeAcc, event);
	}
	if (piAcc.seen) return accumulatorToStats(piAcc);
	if (claudeAcc.seen) return accumulatorToStats(claudeAcc);
	return null;
}

function accumulatorToStats(acc: SessionStatsAccumulator): SessionStats {
	return {
		tokensInput: acc.tokensInput,
		tokensOutput: acc.tokensOutput,
		tokensCacheRead: acc.tokensCacheRead,
		tokensCacheWrite: acc.tokensCacheWrite,
	};
}

/**
 * Adapt an `EventRow` to the structural shape the accumulators consume.
 * The events table stores `payloadJson` (parsed by drizzle's JSON mode);
 * the burrow `RunEvent` keeps it as `payload`. The accumulators only
 * read the parsed value, so the rename is the only adapter needed.
 */
export function eventRowToUsageInput(row: {
	readonly kind: string;
	readonly stream: string | null;
	readonly payloadJson: unknown;
}): UsageEventInput {
	return { kind: row.kind, stream: row.stream, payload: row.payloadJson };
}
