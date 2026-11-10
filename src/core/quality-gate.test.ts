import { describe, expect, test } from "bun:test";
import {
	hasQualityGateWitness,
	type QualityGateEvent,
	reportWithVerifiedGate,
} from "./quality-gate.ts";

const commit = "a".repeat(40);
const success: QualityGateEvent = {
	kind: "quality_gate.completed",
	stream: "system",
	payloadJson: { commit, command: "check", exitCode: 0 },
};
describe("hasQualityGateWitness", () => {
	test("requires an exact successful runtime witness", () => {
		expect(hasQualityGateWitness([success], commit)).toBe(true);
		expect(hasQualityGateWitness([success], "b".repeat(40))).toBe(false);
		expect(hasQualityGateWitness([{ ...success, stream: "stdout" }], commit)).toBe(false);
		expect(
			hasQualityGateWitness(
				[{ ...success, payloadJson: { commit, command: "check", exitCode: 1 } }],
				commit,
			),
		).toBe(false);
		expect(hasQualityGateWitness([], commit)).toBe(false);
	});
	test("refuses stale success when a later execution is unfinished or failed", () => {
		expect(
			hasQualityGateWitness([success, { ...success, kind: "quality_gate.started" }], commit),
		).toBe(false);
		expect(
			hasQualityGateWitness(
				[success, { ...success, payloadJson: { commit, command: "check", exitCode: 1 } }],
				commit,
			),
		).toBe(false);
	});
	test("reconciles only the matching report header and preserves findings", () => {
		const report = `VERDICT: PASS\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: NOT_RUN\nNotes: reviewed`;
		expect(reportWithVerifiedGate(report, commit)).toBe(report.replace("NOT_RUN", "PASS"));
		expect(reportWithVerifiedGate(report, "b".repeat(40))).toBe(report);
	});
});
