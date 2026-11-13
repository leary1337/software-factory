import { describe, expect, test } from "bun:test";
import { summarizeReviewEvidence } from "../core/review-evidence.ts";
import { decideReviewStep, loadSteps, type ReviewRepos } from "./review.ts";

const commit = "a".repeat(40);
const report = `VERDICT: CHANGES\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: FAIL\nlogin.test.ts:12: incorrect status code`;
const receipt = {
	kind: "review.check_failed",
	stream: "system",
	payloadJson: { commit, agentExitCode: 0, exitCode: 1, report },
};

function repos(state: string, events = [receipt]): ReviewRepos {
	return {
		runs: {
			require: async () => ({
				id: "review",
				state,
				failureReason: "crashed",
				baseCommit: commit,
				endedAt: new Date().toISOString(),
			}),
		},
		events: {
			listByRun: async (id: string) =>
				id === "implementation"
					? [
							{
								kind: "plan_run.review_step",
								payloadJson: { step: "review", stepRunId: "review", reviewedCommit: commit },
							},
						]
					: events,
			listTail: async () => [],
		},
	} as unknown as ReviewRepos;
}

function invalidEvents(scenario: string) {
	let events = [receipt];
	if (scenario === "no-receipt") events = [];
	if (scenario === "PASS")
		events = [
			{
				...receipt,
				payloadJson: { ...receipt.payloadJson, report: report.replace("CHANGES", "PASS") },
			},
		];
	if (scenario === "wrong-sha")
		events = [{ ...receipt, payloadJson: { ...receipt.payloadJson, commit: "b".repeat(40) } }];
	if (scenario === "spoofed") events = [{ ...receipt, stream: "stdout" }];
	if (scenario === "new-gate") events.push({ ...receipt, kind: "quality_gate.started" });
	return events;
}

describe("failed gate review", () => {
	test("dispatches rework for acceptance failure while retaining the independently passing full gate", async () => {
		const acceptanceReceipt = {
			...receipt,
			payloadJson: {
				...receipt.payloadJson,
				qualityGate: "PASS",
				report: report.replace("QUALITY_GATE: FAIL", "QUALITY_GATE: PASS"),
			},
		};
		const steps = await loadSteps(repos("failed", [acceptanceReceipt]), "implementation");
		expect(decideReviewStep(steps)).toMatchObject({ kind: "spawn", step: "rework" });
		expect(
			summarizeReviewEvidence(null, "failed", "crashed", commit, [acceptanceReceipt]),
		).toMatchObject({ status: "changes_requested", qualityGate: "PASS" });
	});
	test("dispatches rework from clean pinned CHANGES even when the independent test fails", async () => {
		const steps = await loadSteps(repos("failed"), "implementation");
		expect(steps[0]?.gateVerified).toBe(false);
		expect(decideReviewStep(steps)).toEqual({ kind: "spawn", step: "rework", findings: report });
		expect(summarizeReviewEvidence(null, "failed", "crashed", commit, [receipt])).toMatchObject({
			status: "changes_requested",
			qualityGate: "FAIL",
			gateVerified: false,
		});
	});
	for (const scenario of [
		"cancelled",
		"no-receipt",
		"PASS",
		"wrong-sha",
		"spoofed",
		"new-gate",
	] as const) {
		test(`never accepts ${scenario} reviews and bounds automatic retries`, async () => {
			const events = invalidEvents(scenario);
			const steps = await loadSteps(
				repos(scenario === "cancelled" ? "cancelled" : "failed", events),
				"implementation",
			);
			if (scenario === "cancelled") {
				expect(decideReviewStep(steps)).toMatchObject({ kind: "finished", outcome: "broken" });
				return;
			}
			expect(decideReviewStep(steps)).toMatchObject({ kind: "spawn", step: "review" });
			const retries = steps.map((step) => ({ ...step, recoveryReason: "crashed" }));
			expect(decideReviewStep([...steps, ...retries, ...retries])).toMatchObject({
				kind: "finished",
				outcome: "broken",
			});
		});
	}
});
