import { describe, expect, test } from "bun:test";
import { parseBaseAutoMergeConfig } from "../runs/reap/auto-merge-git.ts";
import { AcceptanceConfigSchema } from "./acceptance-config.ts";

describe("AcceptanceConfigSchema", () => {
	test("rejects duplicate ids and artifact traversal", () => {
		expect(
			AcceptanceConfigSchema.safeParse({
				checks: [
					{ id: "same", command: "test" },
					{ id: "same", command: "test" },
				],
			}).success,
		).toBe(false);
		for (const path of ["../secret", "/etc/passwd", "a/../../b", "a\\b"])
			expect(
				AcceptanceConfigSchema.safeParse({
					checks: [{ id: "check", command: "test", artifacts: [path] }],
				}).success,
			).toBe(false);
	});
	test("protects approved acceptance scripts and fails closed on invalid policy", () => {
		const policy = parseBaseAutoMergeConfig(
			"pr:\n  autoMerge: {}\nacceptance:\n  checks:\n    - id: login\n      command: ./verification/login.sh\n",
		);
		expect(policy?.protectedPaths).toContain("verification/login.sh");
		expect(
			parseBaseAutoMergeConfig("pr:\n  autoMerge: {}\nacceptance:\n  enforce: wrong\n"),
		).toBeUndefined();
	});
});
