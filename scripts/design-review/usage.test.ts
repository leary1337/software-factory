import { describe, expect, test } from "bun:test";

import { extractUsage, parseUsage } from "./usage.ts";

describe("extractUsage", () => {
	test("reads cost and turns from the last result message", () => {
		const messages = [
			{ type: "system" },
			{ type: "result", total_cost_usd: 0.1, num_turns: 2 },
			{ type: "assistant" },
			{ type: "result", total_cost_usd: 1.5, num_turns: 31 },
		];
		expect(extractUsage(messages)).toEqual({ turns: 31 });
	});

	test("reports nulls for a missing, odd, or partial file", () => {
		expect(extractUsage(null)).toEqual({ turns: null });
		expect(extractUsage({ type: "result" })).toEqual({ turns: null });
		expect(extractUsage([{ type: "result", total_cost_usd: "1", num_turns: -1 }])).toEqual({
			turns: null,
		});
	});
});

describe("parseUsage", () => {
	test("round-trips what the CLI prints and rejects junk", () => {
		expect(parseUsage(JSON.stringify({ turns: 9 }))).toEqual({ turns: 9 });
		expect(parseUsage("not json")).toBeNull();
		expect(parseUsage(null)).toBeNull();
		expect(parseUsage("null")).toEqual({ turns: null });
	});
});
