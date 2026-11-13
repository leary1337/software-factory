import { describe, expect, test } from "bun:test";
import { piMessageDelta, piTurnStart } from "./test-helpers.ts";
import {
	DEFAULT_TURN_DEGENERATE_MIN_BYTES,
	DEFAULT_TURN_DEGENERATE_MIN_DELTAS,
	DEFAULT_TURN_STALL_MS,
	type TurnClock,
	TurnMonitor,
	type TurnMonitorOptions,
	turnMonitorOptionsFromEnv,
} from "./turn-monitor.ts";

/** Manual clock — the test advances wall time without sleeping. */
class FakeClock implements TurnClock {
	nowMs = 0;
	now(): number {
		return this.nowMs;
	}
	advance(ms: number): void {
		this.nowMs += ms;
	}
}

function makeMonitor(
	overrides: Partial<TurnMonitorOptions> = {},
	clock = new FakeClock(),
): TurnMonitor {
	return new TurnMonitor({
		stallMs: 1_000,
		stallCheckIntervalMs: 5,
		degenerateMinDeltas: 3,
		degenerateMinBytes: null,
		clock,
		...overrides,
	});
}

describe("turnMonitorOptionsFromEnv", () => {
	test("falls back to the built-in defaults when nothing is set", () => {
		const options = turnMonitorOptionsFromEnv({});
		expect(options.stallMs).toBe(DEFAULT_TURN_STALL_MS);
		expect(options.degenerateMinDeltas).toBe(DEFAULT_TURN_DEGENERATE_MIN_DELTAS);
		expect(options.degenerateMinBytes).toBe(DEFAULT_TURN_DEGENERATE_MIN_BYTES);
	});

	test("throws on a malformed value so a deploy-config typo fails loud", () => {
		expect(() => turnMonitorOptionsFromEnv({ WARREN_TURN_STALL_MS: "soon" })).toThrow();
	});
});

describe("TurnMonitor", () => {
	test("trips degeneration on the byte threshold alone", () => {
		const monitor = makeMonitor({ degenerateMinDeltas: null, degenerateMinBytes: 6 });
		expect(monitor.observe(piTurnStart("run", 1))).toBeNull();
		expect(monitor.observe(piMessageDelta("run", 2, { delta: "    " }))).toBeNull();
		const trip = monitor.observe(piMessageDelta("run", 3, { delta: "  \n\t" }));
		expect(trip).toMatchObject({ kind: "degenerate", deltaCount: 2, byteCount: 8 });
	});

	test("ignores non-update envelopes and non-delta update events", () => {
		const monitor = makeMonitor({ degenerateMinDeltas: 1 });
		expect(monitor.observe(piTurnStart("run", 1))).toBeNull();
		// message_end-shaped / unknown payloads carry no delta to count.
		const skeleton = piMessageDelta("run", 2, { delta: " " });
		(skeleton.payload as { assistantMessageEvent: unknown }).assistantMessageEvent = {
			type: "thinking_start",
			contentIndex: 0,
		};
		expect(monitor.observe(skeleton)).toBeNull();
	});

	test("fires the stall timer only while a turn is open, and only once", async () => {
		const clock = new FakeClock();
		const monitor = makeMonitor({ stallMs: 1_000, stallCheckIntervalMs: 2 }, clock);
		const stalled: unknown[] = [];
		monitor.start((trip) => stalled.push(trip));
		// Idle before any turn_start never trips (watchdog owns run-start idle).
		clock.advance(5_000);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(0);

		monitor.observe(piTurnStart("run", 1));
		clock.advance(1_500);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(1);
		expect(stalled[0]).toMatchObject({ kind: "stalled", idleMs: 1_500, stallMs: 1_000 });
		// Tripped once: the timer disarmed itself.
		clock.advance(5_000);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(1);
		monitor.stop();
	});

	test("stop() disarms the stall timer", async () => {
		const clock = new FakeClock();
		const monitor = makeMonitor({ stallMs: 1_000, stallCheckIntervalMs: 2 }, clock);
		const stalled: unknown[] = [];
		monitor.observe(piTurnStart("run", 1));
		monitor.start((trip) => stalled.push(trip));
		monitor.stop();
		clock.advance(5_000);
		await Bun.sleep(10);
		expect(stalled).toHaveLength(0);
	});

	test("start() is a no-op when stall detection is disabled", () => {
		const clock = new FakeClock();
		const monitor = makeMonitor({ stallMs: null }, clock);
		const stalled: unknown[] = [];
		monitor.observe(piTurnStart("run", 1));
		monitor.start((trip) => stalled.push(trip));
		monitor.stop();
		clock.advance(5_000);
		expect(stalled).toHaveLength(0);
	});
});
