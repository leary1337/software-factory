import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../core/errors.ts";
import { optionalEnum, optionalObject } from "./body-fields.ts";

describe("optionalEnum", () => {
	test("returns undefined for an absent field and the value when allowed", () => {
		expect(optionalEnum({}, "priority", ["low", "high"])).toBeUndefined();
		expect(optionalEnum({ priority: "low" }, "priority", ["low", "high"])).toBe("low");
	});

	test("rejects a value outside the allowed tuple", () => {
		expect(() => optionalEnum({ priority: "urgent" }, "priority", ["low", "high"])).toThrow(
			ValidationError,
		);
	});
});

describe("optionalObject", () => {
	test("returns undefined for an absent field and the record when an object", () => {
		expect(optionalObject({}, "metadata")).toBeUndefined();
		expect(optionalObject({ metadata: { a: 1 } }, "metadata")).toEqual({ a: 1 });
	});

	test("rejects arrays and scalars", () => {
		expect(() => optionalObject({ metadata: [1] }, "metadata")).toThrow(ValidationError);
		expect(() => optionalObject({ metadata: "x" }, "metadata")).toThrow(ValidationError);
	});
});
