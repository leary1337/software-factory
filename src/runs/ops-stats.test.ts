import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import type { RunTokenAggregate } from "../db/repos/runs-stats.ts";
import type { RunState } from "../db/schema.ts";
import {
	DEFAULT_OPS_STATS_TICK_MS,
	loadOpsStatsConfigFromEnv,
	type OpsStatsLogger,
	type OpsStatsProvider,
	runOpsStatsTick,
	startOpsStatsWorker,
} from "./ops-stats.ts";

function makeStats(
	byState: Partial<Record<RunState, number>>,
	cost: RunTokenAggregate,
): OpsStatsProvider {
	const dense: Record<RunState, number> = {
		queued: 0,
		running: 0,
		succeeded: 0,
		failed: 0,
		cancelled: 0,
		...byState,
	};
	return {
		countByState: async () => dense,
		aggregateTokens: async () => cost,
	};
}

function recordingLogger(): OpsStatsLogger & {
	lines: { obj: Record<string, unknown>; msg?: string }[];
} {
	const lines: { obj: Record<string, unknown>; msg?: string }[] = [];
	return {
		lines,
		info: (obj, msg) => lines.push({ obj, ...(msg !== undefined ? { msg } : {}) }),
		error: (obj, msg) => lines.push({ obj, ...(msg !== undefined ? { msg } : {}) }),
	};
}

describe("loadOpsStatsConfigFromEnv", () => {
	test("defaults when env is empty", () => {
		const cfg = loadOpsStatsConfigFromEnv({});
		expect(cfg.tickMs).toBe(DEFAULT_OPS_STATS_TICK_MS);
		expect(cfg.disabled).toBe(false);
	});

	test("parses a positive tick and disabled flag", () => {
		const cfg = loadOpsStatsConfigFromEnv({
			WARREN_OPS_STATS_TICK_MS: "1000",
			WARREN_OPS_STATS_DISABLED: "true",
		});
		expect(cfg.tickMs).toBe(1000);
		expect(cfg.disabled).toBe(true);
	});

	test("rejects a non-positive tick", () => {
		expect(() => loadOpsStatsConfigFromEnv({ WARREN_OPS_STATS_TICK_MS: "0" })).toThrow(
			ValidationError,
		);
		expect(() => loadOpsStatsConfigFromEnv({ WARREN_OPS_STATS_TICK_MS: "nope" })).toThrow(
			ValidationError,
		);
	});
});

describe("runOpsStatsTick", () => {
	test("emits one ops.stats line with state, bridge, and token fields", async () => {
		const logger = recordingLogger();
		let n = 0;
		const snapshot = await runOpsStatsTick({
			stats: makeStats({ running: 2, queued: 1 }, { tokensInput: 300, tokensOutput: 100 }),
			bridges: { size: () => 3 },
			logger,
			clock: () => (n += 5),
		});
		expect(snapshot.activeBridges).toBe(3);
		expect(snapshot.runsByState.running).toBe(2);
		expect(snapshot.tokens).toEqual({ tokensInput: 300, tokensOutput: 100 });
		expect(snapshot.collectMs).toBe(5);
		expect(logger.lines).toHaveLength(1);
		expect(logger.lines[0]?.msg).toBe("ops.stats");
		expect(logger.lines[0]?.obj.activeBridges).toBe(3);
	});
});

describe("startOpsStatsWorker", () => {
	test("disabled worker installs no timer and runOnce is a no-op", async () => {
		let installed = false;
		const handle = startOpsStatsWorker({
			stats: makeStats({}, { tokensInput: 0, tokensOutput: 0 }),
			bridges: { size: () => 0 },
			config: { tickMs: 1000, disabled: true },
			setInterval: () => {
				installed = true;
				return {};
			},
		});
		expect(installed).toBe(false);
		expect(await handle.runOnce()).toBeNull();
		await handle.stop();
	});

	test("runOnce collects a snapshot and counts ticks", async () => {
		const handle = startOpsStatsWorker({
			stats: makeStats({ succeeded: 4 }, { tokensInput: 0, tokensOutput: 0 }),
			bridges: { size: () => 1 },
			config: { tickMs: 1000, disabled: false },
			setInterval: () => ({}),
		});
		const snap = await handle.runOnce();
		expect(snap?.runsByState.succeeded).toBe(4);
		expect(handle.tickCount()).toBe(1);
		await handle.stop();
	});

	test("single-flight drops a tick that fires while one is in flight", async () => {
		let counted = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const dense: Record<RunState, number> = {
			queued: 0,
			running: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
		};
		const slow: OpsStatsProvider = {
			countByState: async () => {
				await gate;
				counted += 1;
				return dense;
			},
			aggregateTokens: async () => ({ tokensInput: 0, tokensOutput: 0 }),
		};
		const handle = startOpsStatsWorker({
			stats: slow,
			bridges: { size: () => 0 },
			config: { tickMs: 1000, disabled: false },
			setInterval: () => ({}),
		});
		const first = handle.runOnce();
		const second = await handle.runOnce(); // dropped — first still in flight
		expect(second).toBeNull();
		release();
		await first;
		expect(counted).toBe(1);
		await handle.stop();
	});

	test("a failing tick is logged and swallowed", async () => {
		const logger = recordingLogger();
		const boom: OpsStatsProvider = {
			countByState: async () => {
				throw new Error("db down");
			},
			aggregateTokens: async () => ({ tokensInput: 0, tokensOutput: 0 }),
		};
		const handle = startOpsStatsWorker({
			stats: boom,
			bridges: { size: () => 0 },
			config: { tickMs: 1000, disabled: false },
			logger,
			setInterval: () => ({}),
		});
		expect(await handle.runOnce()).toBeNull();
		expect(handle.tickCount()).toBe(0);
		expect(logger.lines.some((l) => l.msg === "ops.stats.tick_failed")).toBe(true);
		await handle.stop();
	});
});
