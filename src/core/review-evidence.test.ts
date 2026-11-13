import { describe, expect, test } from "bun:test";
import { summarizeReviewEvidence } from "./review-evidence.ts";

const SHA = "a".repeat(40);
const report = `VERDICT: PASS\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: NOT_RUN\nNo findings.`;
const witness = {
	kind: "quality_gate.completed",
	stream: "system",
	payloadJson: { commit: SHA, command: "check", exitCode: 0 },
};

describe("summarizeReviewEvidence", () => {
	test("uses matching runtime evidence and preserves findings", () => {
		const summary = summarizeReviewEvidence(report, "succeeded", null, SHA, [witness]);
		expect(summary.status).toBe("passed");
		expect(summary.gateVerified).toBe(true);
		expect(summary.reason).toBe("No findings.");
	});
	test("does not turn a prose PASS or another commit's witness into approval", () => {
		const prosePass = report.replace("NOT_RUN", "PASS");
		expect(summarizeReviewEvidence(prosePass, "succeeded", null, SHA, []).status).toBe(
			"checks_not_run",
		);
		expect(
			summarizeReviewEvidence(prosePass, "succeeded", null, SHA, [
				{ ...witness, payloadJson: { ...witness.payloadJson, commit: "b".repeat(40) } },
			]).status,
		).toBe("checks_not_run");
	});
});
