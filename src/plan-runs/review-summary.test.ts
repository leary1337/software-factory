import { describe, expect, test } from "bun:test";
import type { ReviewRepos } from "./review.ts";
import { loadReviewSummaries } from "./review-summary.ts";

const commit = "a".repeat(40);
function repos(): ReviewRepos {
	return {
		events: {
			listByRun: async () => [
				{
					kind: "plan_run.review_step",
					payloadJson: { step: "review", stepRunId: "review-one", reviewedCommit: commit },
				},
				{ kind: "plan_run.review_step", payloadJson: { step: "rework", stepRunId: "rework-one" } },
			],
			listTail: async () => [
				{
					payloadJson: {
						type: "result",
						result: `VERDICT: CHANGES\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: NOT_RUN\nDependencies unavailable.`,
					},
				},
			],
		},
		runs: {
			require: async (id: string) => ({
				id,
				state: id === "review-one" ? "succeeded" : "running",
				failureReason: null,
			}),
		},
	} as unknown as ReviewRepos;
}

describe("loadReviewSummaries", () => {
	test("returns the ordered review and rework history without changing execution states", async () => {
		const steps = await loadReviewSummaries(repos(), "implementation");
		expect(steps.map((step) => step.runId)).toEqual(["review-one", "rework-one"]);
		expect(steps[0]?.executionState).toBe("succeeded");
		expect(steps[0]?.summary?.status).toBe("checks_not_run");
		expect(steps[0]?.summary?.reason).toBe("Dependencies unavailable.");
		expect(steps[1]?.summary).toBeNull();
	});
});
