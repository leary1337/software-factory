import { describe, expect, test } from "bun:test";
import { QualityGateFailure, recordFailedGateReview } from "./quality-gate-failure.ts";
import { LocalRunStore } from "./run-store.ts";

const commit = "a".repeat(40);
const report = `VERDICT: CHANGES\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: NOT_RUN\nTest fails.`;

describe("recordFailedGateReview", () => {
	test("records failed checks without replaying the model success envelope", () => {
		const store = new LocalRunStore();
		const record = store.create({
			runId: "review",
			sandboxId: "review",
			workspacePath: "/tmp/review",
			homePath: "/tmp/home",
			branch: "work",
		});
		recordFailedGateReview(store, record, new QualityGateFailure(commit, 1), 0, undefined, [
			{ kind: "state_change", stream: "system", payload: { type: "result", result: report } },
		]);
		expect(record.events).toHaveLength(1);
		expect(record.events[0]).toMatchObject({
			kind: "review.check_failed",
			stream: "system",
			payload: { commit, exitCode: 1, agentExitCode: 0, report: report.replace("NOT_RUN", "FAIL") },
		});
	});
	for (const scenario of [
		{ name: "crash", agentExit: 1 },
		{ name: "timeout", error: new Error("timed out") },
		{ name: "stream", streamError: new Error("broken stream") },
		{ name: "cancel", cancelled: true },
		{ name: "PASS", report: report.replace("CHANGES", "PASS") },
		{ name: "wrong-sha", error: new QualityGateFailure("b".repeat(40), 1) },
	]) {
		test(`refuses ${scenario.name} as rework evidence`, () => {
			const store = new LocalRunStore();
			const record = store.create({
				runId: "review",
				sandboxId: "review",
				workspacePath: "/tmp/review",
				homePath: "/tmp/home",
				branch: "work",
			});
			record.cancelRequested = scenario.cancelled ?? false;
			recordFailedGateReview(
				store,
				record,
				scenario.error ?? new QualityGateFailure(commit, 1),
				scenario.agentExit ?? 0,
				scenario.streamError,
				[
					{
						kind: "state_change",
						stream: "system",
						payload: { type: "result", result: scenario.report ?? report },
					},
				],
			);
			expect(record.events).toHaveLength(0);
		});
	}
});
