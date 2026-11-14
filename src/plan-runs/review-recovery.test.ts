import { describe, expect, test } from "bun:test";
import type { RunFailureReason } from "../core/wire.ts";
import { decideReviewStep, loadSteps, type ReviewRepos, type ReviewStepRecord } from "./review.ts";
import { DEFAULT_REVIEW_BUDGET } from "./review-progress.ts";
import { reviewHistoryPrompt } from "./review-prompt.ts";

const SHA = "a".repeat(40);
const failed: ReviewStepRecord = {
	step: "review",
	state: "failed",
	failureReason: "crashed",
	resultText: null,
	evidenceRequired: true,
	activeMs: 100,
};

describe("bounded automatic review recovery", () => {
	test("carries an unmaterialized CHANGES report through failed retries", async () => {
		const report = `VERDICT: CHANGES\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: NOT_RUN\nNew defect: malformed rows abort the audit.`;
		const repos = {
			events: {
				listByRun: async (id: string) =>
					id === "parent"
						? [
								{
									kind: "plan_run.review_step",
									payloadJson: {
										step: "review",
										stepRunId: "r",
										reviewedCommit: SHA,
										evidenceRequired: true,
									},
								},
							]
						: [{ payloadJson: { type: "result", result: report } }],
				listTail: async () => [{ payloadJson: { type: "result", result: report } }],
			},
			runs: {
				require: async () => ({
					id: "r",
					state: "failed",
					failureReason: "crashed",
					endedAt: "2026-01-01T00:00:01Z",
				}),
			},
		} as unknown as ReviewRepos;
		const loaded = await loadSteps(repos, "parent");
		expect(loaded[0]?.state).toBe("failed");
		expect(loaded[0]?.resultText).toBe(report);
		const laterFailure = { ...failed, resultText: "VERDICT: PASS" };
		expect(reviewHistoryPrompt([...loaded, laterFailure], false).prompt).toContain(report);
	});
	test("recovers transient infrastructure faults without asking the operator", () => {
		for (const reason of ["provider_error", "sandbox_run_lost", "preempted"] as const)
			for (const step of ["review", "rework"] as const)
				expect(decideReviewStep([{ ...failed, step, failureReason: reason }])).toMatchObject({
					kind: "spawn",
					step,
					recoveryReason: reason,
				});
	});
	test("gives protocol errors two attempts across durable history, never a PASS", () => {
		const malformed = {
			...failed,
			state: "succeeded" as const,
			failureReason: null,
			resultText: "looks fine",
		};
		const decision = decideReviewStep([malformed]);
		expect(decision).toMatchObject({ kind: "spawn", step: "review" });
		if (decision.kind !== "spawn") throw new Error("Expected recovery");
		const retry = { ...malformed, recoveryReason: decision.recoveryReason };
		expect(decideReviewStep([malformed, retry])).toMatchObject({ kind: "spawn", step: "review" });
		expect(decideReviewStep([malformed, retry, retry])).toMatchObject({
			kind: "finished",
			outcome: "broken",
		});
	});
	test("obeys aggregate budgets and preserves permanent or intentional stops", () => {
		for (const budget of [
			{ ...DEFAULT_REVIEW_BUDGET, maxSteps: 1 },
			{ ...DEFAULT_REVIEW_BUDGET, maxActiveMs: 100 },
		])
			expect(decideReviewStep([failed], budget)).toMatchObject({ kind: "finished" });
		for (const reason of [
			null,
			"timed_out",
			"push_rejected_policy",
		] satisfies (RunFailureReason | null)[])
			expect(decideReviewStep([{ ...failed, failureReason: reason }])).toMatchObject({
				kind: "finished",
			});
	});
	test("retains captured proofs and recovery counts when a checker crashes before evidence", async () => {
		const artifacts = [
			{
				id: "preserved",
				title: "Required behavior",
				command: "node repro.cjs",
				files: [{ path: "repro.cjs", contents: "process.exit(1)" }],
			},
		];
		const events = [
			{
				kind: "plan_run.review_step",
				payloadJson: {
					step: "review",
					stepRunId: "r",
					reviewedCommit: SHA,
					evidenceRequired: true,
					recoveryReason: "crashed",
				},
			},
			{
				kind: "review_check.artifacts",
				stream: "system",
				payloadJson: { commit: SHA, findings: artifacts },
			},
		];
		const repos = {
			events: { listByRun: async () => events, listTail: async () => [] },
			runs: {
				require: async () => ({
					id: "r",
					state: "failed",
					failureReason: "crashed",
					startedAt: "2026-01-01T00:00:00Z",
					endedAt: "2026-01-01T00:00:01Z",
				}),
			},
		} as unknown as ReviewRepos;
		const loaded = await loadSteps(repos, "parent");
		expect(loaded[0]?.recoveryReason).toBe("crashed");
		expect(reviewHistoryPrompt(loaded, false).prior).toEqual(artifacts);
		expect(decideReviewStep(loaded)).toMatchObject({ kind: "spawn", step: "review" });
		expect(decideReviewStep([...loaded, ...loaded])).toMatchObject({
			kind: "finished",
			outcome: "broken",
		});
	});
});
