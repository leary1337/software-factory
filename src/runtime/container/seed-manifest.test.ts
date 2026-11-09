import { describe, expect, test } from "bun:test";
import { RuntimeProviderError } from "../errors.ts";
import { parseSeedManifest } from "./seed-manifest.ts";

describe("parseSeedManifest", () => {
	test("keeps path, contents and the optional fields", () => {
		const raw = JSON.stringify([{ path: "a", contents: "b", encoding: "base64", mode: 420 }]);
		expect(parseSeedManifest(raw)).toEqual([
			{ path: "a", contents: "b", encoding: "base64", mode: 420 },
		]);
	});

	test.each(["not json", "{}", "[1]", '[{"path":"a"}]'])("rejects %s", (raw) => {
		expect(() => parseSeedManifest(raw)).toThrow(RuntimeProviderError);
	});
});
