import { describe, expect, test } from "bun:test";
import type { ReviewStepSummary } from "../../api/review-types.ts";
import { historyEntries, historyResult } from "./history-entries.ts";

const step = (kind: ReviewStepSummary["step"], id: string): ReviewStepSummary => ({
	step: kind,
	runId: id,
	executionState: "succeeded",
	summary: null,
});

describe("historyEntries", () => {
	test("keeps per-role numbering stable when filtering or reversing the history", () => {
		const input = [
			step("review", "a"),
			step("rework", "b"),
			step("ui_review", "c"),
			step("review", "d"),
		];
		const entries = historyEntries(input);
		expect(entries.map((entry) => entry.label)).toEqual([
			"Review 1",
			"Rework 1",
			"UI/UX review 1",
			"Review 2",
		]);
		expect(
			entries
				.filter(({ step }) => step.step === "review")
				.reverse()
				.map((entry) => entry.label),
		).toEqual(["Review 2", "Review 1"]);
		expect(input.map((entry) => entry.runId)).toEqual(["a", "b", "c", "d"]);
	});
});

describe("historyResult", () => {
	test("keeps execution completion separate from review approval", () => {
		const changes = {
			...step("review", "a"),
			summary: { status: "changes_requested", verdict: "CHANGES" },
		} as ReviewStepSummary;
		expect(historyResult(changes)).toBe("Changes requested");
		expect(historyResult({ ...changes, step: "rework" })).toBe("Execution: succeeded");
		expect(historyResult(step("review", "b"))).toContain("verdict unavailable");
	});
});
