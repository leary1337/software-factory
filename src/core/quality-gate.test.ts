import { describe, expect, test } from "bun:test";
import { isQualityGateGreen, qualityGateRan, readQualityGateResult } from "./quality-gate.ts";

const finished = {
	type: "quality_gate",
	phase: "finished",
	command: "make check",
	exitCode: 0,
	timedOut: false,
	durationMs: 1200,
	sha: "abc",
	logTail: "ok\n",
};

describe("readQualityGateResult", () => {
	test("reads a finished payload", () => {
		expect(readQualityGateResult(finished)).toEqual({
			command: "make check",
			exitCode: 0,
			timedOut: false,
			durationMs: 1200,
			sha: "abc",
			logTail: "ok\n",
		});
	});

	test("ignores the started phase and foreign payloads", () => {
		expect(readQualityGateResult({ ...finished, phase: "started" })).toBeNull();
		expect(readQualityGateResult({ type: "result" })).toBeNull();
		expect(readQualityGateResult("quality_gate")).toBeNull();
		expect(readQualityGateResult({ ...finished, exitCode: "0" })).toBeNull();
	});

	test("normalizes an empty sha and keeps a start error", () => {
		const result = readQualityGateResult({ ...finished, exitCode: null, sha: "", error: "boom" });
		expect(result).toMatchObject({ sha: null, exitCode: null, error: "boom" });
	});
});

describe("isQualityGateGreen", () => {
	test("is green only on a real exit 0", () => {
		const green = readQualityGateResult(finished);
		if (green === null) throw new Error("unreadable");
		expect(isQualityGateGreen(green)).toBe(true);
		expect(isQualityGateGreen({ ...green, exitCode: 2 })).toBe(false);
		expect(isQualityGateGreen({ ...green, timedOut: true })).toBe(false);
		expect(isQualityGateGreen({ ...green, error: "x" })).toBe(false);
		expect(qualityGateRan({ ...green, exitCode: 2 })).toBe(true);
		expect(qualityGateRan({ ...green, error: "x" })).toBe(false);
	});
});
