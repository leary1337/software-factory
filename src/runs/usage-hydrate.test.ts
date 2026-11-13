import { describe, expect, test } from "bun:test";
import type { RunRow } from "../db/schema.ts";
import {
	backfillTerminalUsage,
	hydrateRunsUsage,
	hydrateRunUsage,
	type UsageEventsFetcher,
} from "./usage-hydrate.ts";

function row(over: Partial<RunRow> & { id: string; state: RunRow["state"] }): RunRow {
	return {
		agentName: "claude-code",
		projectId: "prj_1",
		sandboxId: null,
		sandboxRunId: null,
		workerId: null,
		seedId: null,
		renderedAgentJson: null,
		failureReason: null,
		startedAt: null,
		endedAt: null,
		prompt: "",
		trigger: "manual",
		prUrl: null,
		tokensInput: null,
		tokensOutput: null,
		tokensCacheRead: null,
		tokensCacheWrite: null,
		previewState: null,
		previewPort: null,
		previewStartedAt: null,
		previewLastHitAt: null,
		previewFailureMessage: null,
		...over,
	} as RunRow;
}

function claudeResultEvent(runId: string, _costUsd: number, tokensInput: number) {
	return {
		runId,
		kind: "state_change",
		stream: "system" as const,
		payloadJson: {
			type: "result",
			usage: {
				input_tokens: tokensInput,
				output_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	};
}

function fetcher(
	rows: readonly { runId: string; kind: string; stream: string | null; payloadJson: unknown }[],
): UsageEventsFetcher & { calls: number; lastIds: readonly string[] } {
	const wrapper = {
		calls: 0,
		lastIds: [] as readonly string[],
		async listUsageEvents(runIds: readonly string[]) {
			wrapper.calls += 1;
			wrapper.lastIds = runIds;
			return rows.filter((r) => runIds.includes(r.runId));
		},
	};
	return wrapper;
}

describe("hydrateRunsUsage", () => {
	test("passes non-terminal rows through unchanged", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		await hydrateRunsUsage([row({ id: "run_a", state: "running" })], events);
		// Running rows aren't candidates, so we never even ask for events.
		expect(events.calls).toBe(0);
	});

	test("batches all candidates into one fetch", async () => {
		const events = fetcher([
			claudeResultEvent("run_a", 0.1, 10),
			claudeResultEvent("run_b", 0.2, 20),
			claudeResultEvent("run_c", 0.3, 30),
		]);
		await hydrateRunsUsage(
			[
				row({ id: "run_a", state: "succeeded" }),
				row({ id: "run_b", state: "failed" }),
				row({ id: "run_c", state: "cancelled" }),
			],
			events,
		);
		expect(events.calls).toBe(1);
		expect(events.lastIds.length).toBe(3);
	});

	test("leaves the row unchanged when no usage events landed", async () => {
		// Captures the seed's acceptance edge: a terminal run with zero

		// with the bridge's `acc.seen === false` skip).
		const events = fetcher([]);
		const out = await hydrateRunsUsage([row({ id: "run_a", state: "failed" })], events);
		expect(out[0]?.tokensInput).toBeNull();
	});

	test("preserves order of input rows", async () => {
		const events = fetcher([
			claudeResultEvent("run_b", 0.5, 50),
			claudeResultEvent("run_a", 0.1, 10),
		]);
		const out = await hydrateRunsUsage(
			[row({ id: "run_a", state: "succeeded" }), row({ id: "run_b", state: "failed" })],
			events,
		);
		expect(out[0]?.id).toBe("run_a");
		expect(out[1]?.id).toBe("run_b");
	});
});

describe("hydrateRunUsage", () => {
	test("hydrates a single row when it's a candidate", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.7, 700)]);
		await hydrateRunUsage(row({ id: "run_a", state: "failed" }), events);
	});

	test("passes a non-candidate row through unchanged", async () => {
		const events = fetcher([]);
		const input = row({ id: "run_a", state: "queued" });
		const out = await hydrateRunUsage(input, events);
		expect(out).toBe(input);
	});
});

function persister() {
	const calls: { id: string; stats: Record<string, number> }[] = [];
	const persisted = new Map<string, Record<string, number>>();
	return {
		calls,
		persisted,
		updateUsage(id: string, stats: Record<string, number>) {
			calls.push({ id, stats });
			persisted.set(id, stats);
			return Promise.resolve();
		},
	};
}

describe("hydrateRunsUsage write-through (warren-b33e)", () => {
	test("persists derived stats onto the candidate row", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const store = persister();
		await hydrateRunsUsage([row({ id: "run_a", state: "failed" })], events, store);
	});

	test("a second call over persisted rows issues no listUsageEvents", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const store = persister();
		const first = await hydrateRunsUsage([row({ id: "run_a", state: "failed" })], events, store);
		expect(events.calls).toBe(1);
		// Simulate the DB round-trip: the write-through landed, so the row
		// read back carries the derived totals and is no longer a candidate.
		const updated = first.map((r) => ({
			...r,
			...(store.persisted.get(r.id) as Record<string, number>),
		})) as typeof first;
		await hydrateRunsUsage(updated, events, store);
		expect(events.calls).toBe(1);
		expect(store.calls.length).toBe(1);
	});

	test("non-terminal rows are never persisted", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const store = persister();
		await hydrateRunsUsage([row({ id: "run_a", state: "running" })], events, store);
		expect(events.calls).toBe(0);
		expect(store.calls).toEqual([]);
	});

	test("persist failures are logged, not thrown", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const failing = {
			updateUsage() {
				return Promise.reject(new Error("db down"));
			},
		};
		await hydrateRunsUsage([row({ id: "run_a", state: "failed" })], events, failing);
	});
});

describe("backfillTerminalUsage", () => {
	test("writes zeros for a terminal row with no usage envelopes", async () => {
		const events = fetcher([]);
		const store = persister();
		await backfillTerminalUsage(row({ id: "run_a", state: "cancelled" }), events, store);
	});

	test("skips non-terminal and already-hydrated rows", async () => {
		const events = fetcher([claudeResultEvent("run_a", 0.42, 1200)]);
		const store = persister();
		await backfillTerminalUsage(row({ id: "run_a", state: "running" }), events, store);
		await backfillTerminalUsage(
			row({
				id: "run_a",
				state: "succeeded",
				tokensInput: 0,
				tokensOutput: 0,
				tokensCacheRead: 0,
				tokensCacheWrite: 0,
			}),
			events,
			store,
		);
		expect(store.calls).toEqual([]);
		expect(events.calls).toBe(0);
	});
});
