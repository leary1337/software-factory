import { describe, expect, test } from "bun:test";
import { DeployConfigSchema } from "./pr-config.ts";

describe("DeployConfigSchema", () => {
	test("keeps automatic deployment disabled by default with bounded timeouts", () => {
		expect(DeployConfigSchema.parse({})).toEqual({
			autoDeploy: false,
			timeoutMs: 900_000,
			smokeTimeoutMs: 10_000,
		});
	});
	test("requires an explicit HTTP smoke endpoint when opted in", () => {
		expect(DeployConfigSchema.safeParse({ autoDeploy: true }).success).toBe(false);
		expect(
			DeployConfigSchema.safeParse({ autoDeploy: true, smokeUrl: "file:///tmp/health" }).success,
		).toBe(false);
		expect(
			DeployConfigSchema.safeParse({
				autoDeploy: true,
				shaInput: "factory_sha",
				smokeUrl: "https://example.test/health",
			}).success,
		).toBe(true);
	});
	test("rejects unbounded or excessive verification timeouts", () => {
		for (const config of [
			{ timeoutMs: 0 },
			{ timeoutMs: 3_600_001 },
			{ smokeTimeoutMs: 0 },
			{ smokeTimeoutMs: 60_001 },
		])
			expect(DeployConfigSchema.safeParse(config).success).toBe(false);
	});
});
