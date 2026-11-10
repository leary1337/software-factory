import { describe, expect, test } from "bun:test";
import { CODEX_DEFAULT_MODEL } from "../../runtime/adapters/codex-config.ts";
import { adapterFor } from "../../runtime/adapters/index.ts";
import { DefaultsConfigSchema } from "../../warren-config/schema.ts";
import { readRuntimeId } from "../schema.ts";
import { BUILTIN_AGENTS } from "./index.ts";

const services = BUILTIN_AGENTS.filter((agent) => !["pi", "claude-code"].includes(agent.name));

describe("Codex service agents", () => {
	test.each(services)("launches $name through the subscription adapter", (agent) => {
		const runtime = readRuntimeId(agent);
		expect(runtime).toBe("codex");
		if (runtime !== "codex") throw new Error(`${agent.name} uses ${runtime}`);
		expect(agent.frontmatter.provider).toBe("openai");
		expect(agent.frontmatter.model).toBe(CODEX_DEFAULT_MODEL);
		expect(adapterFor(runtime).costBasis).toBe("subscription_estimate");
	});

	test("resolves automatic repair defaults to Codex service roles", () => {
		const defaults = DefaultsConfigSchema.parse({ ciFixer: {}, healer: {} });
		for (const role of [defaults.ciFixer?.role, defaults.healer?.role]) {
			const agent = services.find((candidate) => candidate.name === role);
			expect(agent).toBeDefined();
			if (!agent) throw new Error(`Missing automatic repair role: ${role}`);
			expect(readRuntimeId(agent)).toBe("codex");
		}
	});
});
