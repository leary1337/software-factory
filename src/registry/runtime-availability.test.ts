import { describe, expect, test } from "bun:test";
import { isRetiredAgent, readRunnableRuntimeId } from "./runtime-availability.ts";
import type { AgentDefinition } from "./schema.ts";

const agent: AgentDefinition = {
	name: "executor",
	version: 1,
	sections: { system: "Execute the approved task." },
	resolvedFrom: [],
	frontmatter: { runtime: "codex" },
};

describe("readRunnableRuntimeId", () => {
	test.each(["nightwatch", "bugwatch"])("hides and refuses saved patrol %s", (name) => {
		const historical = { ...agent, name };
		expect(isRetiredAgent({ name, renderedJson: historical })).toBe(true);
		expect(() => readRunnableRuntimeId(historical)).toThrow("patrols are retired");
		expect(historical.name).toBe(name);
	});

	test("rejects a retired project override before dispatch", () => {
		expect(() => readRunnableRuntimeId(agent, "pi")).toThrow("retired runtime");
	});

	test("refuses to reinterpret an old Pi definition as another runtime", () => {
		const historical = { ...agent, frontmatter: { runtime: "pi" } };
		expect(() => readRunnableRuntimeId(historical, "codex")).toThrow("retired runtime");
		expect(historical.frontmatter.runtime).toBe("pi");
	});

	test("keeps Codex and Claude Code executable", () => {
		expect(readRunnableRuntimeId(agent)).toBe("codex");
		expect(readRunnableRuntimeId(agent, "claude-code")).toBe("claude-code");
	});
});

describe("isRetiredAgent", () => {
	test("recognizes the historical Pi name when its runtime was implicit", () => {
		expect(isRetiredAgent({ name: "pi", renderedJson: { frontmatter: {} } })).toBe(true);
	});

	test("keeps malformed historical rows readable", () => {
		expect(isRetiredAgent({ name: "legacy", renderedJson: null })).toBe(false);
	});
});
