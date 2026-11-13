import { describe, expect, test } from "bun:test";
import { executionDuration } from "./execution-timing-data.ts";

const startedAt = "2026-06-01T10:00:00.000Z";
const endedAt = "2026-06-01T10:02:30.000Z";
const now = Date.parse("2026-06-01T11:03:04.000Z");

describe("executionDuration", () => {
	test("uses the completed execution interval rather than time since it ended", () => {
		expect(executionDuration({ startedAt, endedAt, state: "succeeded" }, now)).toBe("2m 30s");
		expect(executionDuration({ startedAt, endedAt: startedAt, state: "failed" }, now)).toBe("0s");
	});
	test("updates elapsed time only while the execution is still active", () => {
		expect(executionDuration({ startedAt, endedAt: null, state: "running" }, now)).toBe("1h 3m 4s");
		for (const state of ["succeeded", "failed", "cancelled"] as const) {
			expect(executionDuration({ startedAt, endedAt: null, state }, now)).toBe("Unknown");
		}
	});
	test("distinguishes an unstarted step from missing or invalid timestamps", () => {
		expect(executionDuration({ startedAt: null, endedAt: null, state: "queued" }, now)).toBe(
			"Not started",
		);
		expect(executionDuration({ startedAt: "invalid", endedAt, state: "succeeded" }, now)).toBe(
			"Unknown",
		);
		expect(
			executionDuration({ startedAt: endedAt, endedAt: startedAt, state: "succeeded" }, now),
		).toBe("Unknown");
	});
});
