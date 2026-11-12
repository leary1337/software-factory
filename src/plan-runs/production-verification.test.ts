import { describe, expect, test } from "bun:test";
import { loadProductionVerification } from "./production-verification.ts";
import type { ReviewRepos } from "./review.ts";

function repos(events: unknown[]): ReviewRepos {
	return { events: { listByRun: async () => events } } as unknown as ReviewRepos;
}
describe("loadProductionVerification", () => {
	test("does not infer delivery from merge, workflow dispatch or an absent execution", async () => {
		expect(await loadProductionVerification(repos([]), null)).toBeNull();
		expect(
			await loadProductionVerification(
				repos([{ kind: "plan_run.deployment_dispatched" }, { kind: "plan_run.pr_merged" }]),
				"run",
			),
		).toBeNull();
	});
	test("returns the latest verified receipt and ignores malformed payloads", async () => {
		const event = {
			kind: "plan_run.deployment_verified",
			ts: "2026-01-01",
			payloadJson: { expectedSha: "a".repeat(40), environment: "production" },
		};
		expect(
			await loadProductionVerification(
				repos([
					event,
					{ ...event, payloadJson: null },
					{ ...event, payloadJson: {} },
					{ ...event, payloadJson: { expectedSha: "b" } },
				]),
				"run",
			),
		).toEqual({ sha: "a".repeat(40), environment: "production", verifiedAt: "2026-01-01" });
	});
});
