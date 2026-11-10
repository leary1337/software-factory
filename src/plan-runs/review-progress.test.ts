import { describe, expect, test } from "bun:test";
import { decideReviewStep, type ReviewStepRecord } from "./review.ts";
import { DEFAULT_REVIEW_BUDGET, loadReviewBudget } from "./review-progress.ts";

const SHA = "a".repeat(40);
function reviewed(open: string[], closed: string[] = []): ReviewStepRecord {
	return {
		step: "review",
		state: "succeeded",
		reviewedCommit: SHA,
		gateVerified: true,
		resultText: `VERDICT: ${open.length ? "CHANGES" : "PASS"}\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: PASS`,
		costUsd: 0.2,
		activeMs: 1000,
		evidenceRequired: true,
		evidence: {
			commit: SHA,
			findings: [...open, ...closed].map((id) => ({
				id,
				title: id,
				command: 'node "$WARREN_REPRO_DIR/test.cjs"',
				files: [{ path: "test.cjs", contents: "process.exit(1)" }],
			})),
			results: [
				...open.map((id) => ({ id, exitCode: 1 })),
				...closed.map((id) => ({ id, exitCode: 0 })),
			],
		},
	} as ReviewStepRecord;
}
const rework: ReviewStepRecord = { step: "rework", state: "succeeded", resultText: "fixed" };

describe("review progress", () => {
	test("continues beyond two reworks when original reproductions close", () => {
		const steps = [
			reviewed(["a"]),
			rework,
			reviewed(["b"], ["a"]),
			rework,
			reviewed(["c"], ["a", "b"]),
		];
		expect(decideReviewStep(steps)).toMatchObject({ kind: "spawn", step: "rework" });
	});
	test("stops a repeated unresolved finding even when rework claims success", () => {
		expect(decideReviewStep([reviewed(["a"]), rework, reviewed(["a"])])).toMatchObject({
			kind: "finished",
			outcome: "changes_left",
			report: expect.stringContaining("no_progress"),
		});
	});
	test("refuses PASS when an original reproduction still fails", () => {
		const last = {
			...reviewed(["a"]),
			resultText: `VERDICT: PASS\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: PASS`,
		};
		expect(decideReviewStep([reviewed(["a"]), rework, last])).toMatchObject({
			kind: "finished",
			outcome: "changes_left",
		});
	});
	test("does not count a renamed finding as progress", () => {
		expect(decideReviewStep([reviewed(["a"]), rework, reviewed(["new-name"])])).toMatchObject({
			kind: "finished",
			outcome: "broken",
		});
	});
	test("stops at the aggregate cost budget despite verified progress", () => {
		const steps = [reviewed(["a"]), rework, reviewed(["b"], ["a"])];
		expect(decideReviewStep(steps, { ...DEFAULT_REVIEW_BUDGET, maxCostUsd: 0.4 })).toMatchObject({
			kind: "finished",
			report: expect.stringContaining("cost_budget_exhausted"),
		});
	});
	test("stops on unknown usage, elapsed execution budget and total step limit", () => {
		const steps = [reviewed(["a"]), rework, reviewed(["b"], ["a"])];
		for (const budget of [
			{ ...DEFAULT_REVIEW_BUDGET, maxActiveMs: 2000 },
			{ ...DEFAULT_REVIEW_BUDGET, maxSteps: 3 },
		])
			expect(decideReviewStep(steps, budget)).toMatchObject({
				kind: "finished",
				outcome: "changes_left",
			});
		expect(decideReviewStep([{ ...reviewed(["a"]), costUsd: null }])).toMatchObject({
			kind: "finished",
			report: expect.stringContaining("budget_unknown"),
		});
	});
	test("refuses reopened regressions even when another finding closes", () => {
		expect(
			decideReviewStep([reviewed(["a"], ["b"]), rework, reviewed(["b"], ["a"])]),
		).toMatchObject({ kind: "finished", report: expect.stringContaining("regression") });
	});
	test("accepts PASS only after every original check passes", () => {
		expect(decideReviewStep([reviewed(["a"]), rework, reviewed([], ["a"])])).toMatchObject({
			kind: "finished",
			outcome: "passed",
		});
	});
	test("rejects changing the original test source", () => {
		const last = reviewed([], ["a"]);
		if (!last.evidence) throw new Error("fixture evidence missing");
		const altered = {
			...last,
			evidence: {
				...last.evidence,
				findings: last.evidence.findings.map((finding) => ({ ...finding, command: "true" })),
			},
		};
		expect(decideReviewStep([reviewed(["a"]), rework, altered])).toMatchObject({
			kind: "finished",
			outcome: "broken",
		});
	});
	test("validates operator budget settings", () => {
		expect(loadReviewBudget({ WARREN_REWORK_MAX_COST_USD: "5" }).maxCostUsd).toBe(5);
		for (const invalid of ["", "-1", "NaN", "Infinity"])
			expect(() => loadReviewBudget({ WARREN_REWORK_MAX_COST_USD: invalid })).toThrow();
	});
});
