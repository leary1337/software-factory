import { describe, expect, test } from "bun:test";
import { healthLabel, runtimeValue } from "./console-topbar.helpers.ts";

describe("healthLabel", () => {
	test("renders HEALTHY when the /healthz probe is ok", () => {
		expect(healthLabel("ok")).toBe("HEALTHY");
	});

	test("renders UNREACHABLE when the /healthz probe fails", () => {
		expect(healthLabel("down")).toBe("UNREACHABLE");
	});

	test("renders an em dash while the probe is unknown", () => {
		expect(healthLabel("unknown")).toBe("—");
	});

	test("label is a single spelling at every width (no CONTROL PLANE variant)", () => {
		for (const h of ["ok", "down", "unknown"] as const) {
			expect(healthLabel(h)).not.toContain("CONTROL PLANE");
		}
	});
});

describe("runtimeValue", () => {
	test("renders the boot-resolved provider upper-cased", () => {
		expect(runtimeValue("local")).toBe("LOCAL");
		expect(runtimeValue("docker")).toBe("DOCKER");
	});

	test("renders null while the instance facts are loading", () => {
		expect(runtimeValue(null)).toBeNull();
	});
});
