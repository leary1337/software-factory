import { describe, expect, test } from "bun:test";
import { DefaultsConfigSchema } from "./schema.ts";

describe("DefaultsConfigSchema tracker block", () => {
	test("uses internal Seeds when the retired block is omitted", () => {
		expect(DefaultsConfigSchema.safeParse({}).success).toBe(true);
	});
	test.each([
		{ url: "http://tracker:8080" },
		{ url: "http://tracker:8080", tokenEnv: "TOKEN" },
		null,
	])("rejects retired external tracker settings explicitly: %j", (tracker) => {
		const result = DefaultsConfigSchema.safeParse({ tracker });
		expect(result.success).toBe(false);
		if (!result.success)
			expect(result.error.issues[0]?.message).toContain("External trackers are retired");
	});
});
