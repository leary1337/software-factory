/**
 * warren-8d95: `seededArtifactResetPaths` reconstructs the warren-seeded
 * pure-context artifact paths (agent envelope + `.seeds/workflow.txt`) from
 * the run's stored agent envelope, excluding the mirror-managed `.mulch/` family.
 */

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "../../registry/schema.ts";
import { seededArtifactResetPaths } from "./seed-reset.ts";

function agent(overrides: Partial<AgentDefinition["sections"]> = {}): AgentDefinition {
	return {
		name: "claude-code",
		version: "1.0.0",
		resolvedFrom: "builtin",
		frontmatter: {},
		sections: {
			system: "you are a bot",
			...overrides,
		},
	} as unknown as AgentDefinition;
}

describe("seededArtifactResetPaths", () => {
	test("includes the agent envelope by default", () => {
		const paths = seededArtifactResetPaths(agent());
		expect(paths.map((p) => p.path)).toContain(".warren/agent.json");
	});

	test("carries the exact seeded agent-envelope bytes for the intentional-edit check", () => {
		const [envelope] = seededArtifactResetPaths(agent());
		expect(envelope?.path).toBe(".warren/agent.json");
		expect(envelope?.contents).toContain('"name": "claude-code"');
		expect(envelope?.contents.endsWith("\n")).toBe(true);
	});

	test("includes current context drops and excludes retired Pi artifacts and .mulch/", () => {
		const paths = seededArtifactResetPaths(
			agent({
				pi_skills: '{"name":"lint","body":"run the linter"}',
				workflow: "do the thing",
				expertise_seed: '{"domain":"build","content":"x"}',
			}),
		).map((p) => p.path);
		expect(paths.some((path) => path.startsWith(".pi/"))).toBe(false);
		expect(paths).toContain(".seeds/workflow.txt");
		expect(paths).toContain(".warren/agent.json");
		expect(paths.some((p) => p.startsWith(".mulch/"))).toBe(false);
	});

	test("returns [] for a missing or non-object renderedAgentJson", () => {
		expect(seededArtifactResetPaths(null)).toEqual([]);
		expect(seededArtifactResetPaths(undefined)).toEqual([]);
		expect(seededArtifactResetPaths("nope")).toEqual([]);
	});

	test("returns [] when the seed builder throws on a malformed section", () => {
		// A non-JSON expertise_seed line makes buildSeedFiles throw; the helper
		// must swallow it so reap degrades rather than failing the run.
		expect(seededArtifactResetPaths(agent({ expertise_seed: "not json" }))).toEqual([]);
	});
});
