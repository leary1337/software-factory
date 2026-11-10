import { describe, expect, test } from "bun:test";
import {
	IMPLEMENTER_BUILTIN,
	REVIEWER_BUILTIN,
	REWORK_BUILTIN,
} from "../../registry/builtins/factory-roles.ts";
import { declaresNoCommits } from "./no-commits.ts";

describe("declaresNoCommits", () => {
	test("reads a true flag from the frozen envelope's frontmatter", () => {
		expect(declaresNoCommits({ renderedAgentJson: { frontmatter: { noCommits: true } } })).toBe(
			true,
		);
	});

	test("treats a missing, false, or malformed envelope as committing", () => {
		for (const renderedAgentJson of [
			null,
			[],
			{},
			{ frontmatter: null },
			{ frontmatter: { noCommits: false } },
			{ frontmatter: { noCommits: "false" } },
		]) {
			expect(declaresNoCommits({ renderedAgentJson })).toBe(false);
		}
	});

	test("only the builtin reviewer declares it among the factory roles", () => {
		const envelope = (def: typeof REVIEWER_BUILTIN) => ({
			renderedAgentJson: { frontmatter: def.frontmatter },
		});
		expect(declaresNoCommits(envelope(REVIEWER_BUILTIN))).toBe(true);
		expect(declaresNoCommits(envelope(IMPLEMENTER_BUILTIN))).toBe(false);
		expect(declaresNoCommits(envelope(REWORK_BUILTIN))).toBe(false);
	});
});
