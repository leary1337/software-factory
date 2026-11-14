import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../registry/schema.ts";
import { RunSpawnError } from "./errors.ts";
import { buildSeedFiles, type SeedFile } from "./seed.ts";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "refactor-bot",
		version: 3,
		sections: { system: "be a refactor agent", ...(overrides.sections ?? {}) },
		resolvedFrom: ["base-coding-agent"],
		frontmatter: {},
		...overrides,
	};
}

function byPath(files: readonly SeedFile[]): Map<string, SeedFile> {
	return new Map(files.map((f) => [f.path, f]));
}

describe("buildSeedFiles", () => {
	test("emits the rendered agent envelope at .warren/agent.json", () => {
		const result = buildSeedFiles(makeAgent());
		const map = byPath(result.files);
		expect(result.agentEnvelopePath).toBe(".warren/agent.json");
		const entry = map.get(".warren/agent.json");
		expect(entry).toBeDefined();
		const parsed = JSON.parse(entry?.contents ?? "");
		expect(parsed.name).toBe("refactor-bot");
		expect(parsed.sections.system).toBe("be a refactor agent");
	});

	test("groups expertise_seed by domain into .mulch/expertise/<domain>.jsonl", () => {
		const seed = [
			'{"type":"convention","domain":"refactor","content":"a"}',
			'{"type":"failure","domain":"refactor","description":"x","resolution":"y"}',
			'{"type":"convention","domain":"build","content":"b"}',
			"",
			"   ",
		].join("\n");
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", expertise_seed: seed } }));
		const map = byPath(result.files);

		expect(result.mulchDomains).toEqual(["build", "refactor"]);
		expect(map.get(".mulch/expertise/refactor.jsonl")?.contents).toBe(
			`${[
				'{"type":"convention","domain":"refactor","content":"a"}',
				'{"type":"failure","domain":"refactor","description":"x","resolution":"y"}',
			].join("\n")}\n`,
		);
		expect(map.get(".mulch/expertise/build.jsonl")?.contents).toBe(
			'{"type":"convention","domain":"build","content":"b"}\n',
		);
	});

	test("rejects malformed expertise_seed lines with RunSpawnError", () => {
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", expertise_seed: "not json" } })),
		).toThrow(RunSpawnError);
	});

	test("rejects expertise_seed lines without a non-empty domain", () => {
		expect(() =>
			buildSeedFiles(makeAgent({ sections: { system: "s", expertise_seed: '{"type":"x"}' } })),
		).toThrow(RunSpawnError);
	});

	test("emits the workflow body verbatim at .seeds/workflow.txt", () => {
		const wf = "template: refactor";
		const result = buildSeedFiles(makeAgent({ sections: { system: "s", workflow: wf } }));
		const map = byPath(result.files);
		expect(result.workflowPath).toBe(".seeds/workflow.txt");
		expect(map.get(".seeds/workflow.txt")?.contents).toBe("template: refactor\n");
	});

	test("preserves a workflow body that already ends with a newline", () => {
		const result = buildSeedFiles(
			makeAgent({ sections: { system: "s", workflow: "template: refactor\n" } }),
		);
		expect(byPath(result.files).get(".seeds/workflow.txt")?.contents).toBe("template: refactor\n");
	});

	test("returns null workflowPath and empty mulchDomains when those sections are absent", () => {
		const result = buildSeedFiles(makeAgent());
		expect(result.workflowPath).toBeNull();
		expect(result.mulchDomains).toEqual([]);
		// Only the agent envelope drops when no optional sections are present.
		expect(result.files.map((f) => f.path)).toEqual([".warren/agent.json"]);
	});

	test("preserves historical Pi sections in the envelope without materializing executable artifacts", () => {
		const sections = {
			system: "s",
			pi_skills: "old skill",
			pi_prompts: "old prompt",
			pi_extensions: "old extension",
		};
		const result = buildSeedFiles(makeAgent({ sections }));
		expect(result.files.some((file) => file.path.startsWith(".pi/"))).toBe(false);
		const envelope = result.files.find((file) => file.path === result.agentEnvelopePath);
		expect(JSON.parse(envelope?.contents ?? "{}").sections).toEqual(sections);
	});

	test("all emitted paths are workspace-relative (no leading slash)", () => {
		const section = JSON.stringify({ name: "x", body: "y" });
		const result = buildSeedFiles(
			makeAgent({
				sections: {
					system: "s",
					workflow: "wf",
					expertise_seed: '{"type":"convention","domain":"d","content":"c"}',
					pi_skills: section,
					pi_prompts: section,
					pi_extensions: section,
				},
			}),
		);
		for (const file of result.files) {
			expect(file.path.startsWith("/")).toBe(false);
			expect(file.path.startsWith(".")).toBe(true);
		}
	});
});
