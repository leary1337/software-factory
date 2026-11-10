import { describe, expect, test } from "bun:test";
import { summarizeReview } from "./review-result.ts";

const SHA = "a".repeat(40);
const report = (verdict: string, gate: string) =>
	`VERDICT: ${verdict}\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: ${gate}\nFix acceptance.`;

describe("summarizeReview", () => {
	test("separates successful execution from changes and unrun checks", () => {
		expect(summarizeReview(report("CHANGES", "PASS"), "succeeded").status).toBe(
			"changes_requested",
		);
		const missing = summarizeReview(report("CHANGES", "NOT_RUN"), "succeeded");
		expect(missing.status).toBe("checks_not_run");
		expect(missing.reason).toBe("Fix acceptance.");
	});
	test("requires a complete PASS and matching pinned commit", () => {
		expect(summarizeReview(report("PASS", "PASS"), "succeeded", null, SHA).status).toBe("passed");
		expect(summarizeReview(report("PASS", "PASS"), "succeeded", null, "b".repeat(40)).status).toBe(
			"error",
		);
		expect(summarizeReview("VERDICT: PASS", "succeeded").status).toBe("error");
		expect(
			summarizeReview(`${report("PASS", "PASS")}\nQUALITY_GATE: FAIL`, "succeeded").status,
		).toBe("error");
	});
	test("keeps running, failed and no-changes reviewer execution distinct", () => {
		expect(summarizeReview(null, "running").status).toBe("pending");
		expect(summarizeReview(null, "succeeded").status).toBe("error");
		expect(summarizeReview(report("PASS", "PASS"), "failed", "agent_error").status).toBe("error");
		expect(summarizeReview(report("PASS", "PASS"), "failed", "no_changes").status).toBe("passed");
	});
});
