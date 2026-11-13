import { describe, expect, test } from "bun:test";
import {
	hasQualityGateWitness,
	type QualityGateEvent,
	reportWithVerifiedGate,
} from "./quality-gate.ts";
import { summarizeReviewEvidence } from "./review-evidence.ts";
import { passedReviewCommit } from "./review-result.ts";

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
	test("reconciles the explicit deferred gate protocol without waiving skipped checks", () => {
		const report = `VERDICT: PASS\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: NOT_RUN\nRUNTIME_GATE: DEFERRED\nNotes: reviewed`;
		const verified = reportWithVerifiedGate(report, commit);
		expect(verified).toContain("RUNTIME_GATE: VERIFIED");
		expect(passedReviewCommit(verified)).toBe(commit);
		expect(summarizeReviewEvidence(report, "succeeded", null, commit, []).status).not.toBe(
			"passed",
		);
		expect(summarizeReviewEvidence(report, "succeeded", null, commit, [success]).status).toBe(
			"passed",
		);
		for (const skipped of [
			"Not run: browser tests",
			"Not run: Full `scripts/check.sh` gate; Warren owns this verification.",
		])
			expect(
				passedReviewCommit(reportWithVerifiedGate(`${report}\n${skipped}`, commit)),
			).toBeNull();
	});
});
