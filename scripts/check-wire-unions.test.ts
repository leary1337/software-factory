import { describe, expect, test } from "bun:test";
import { copiedWireUnions, deliveryVocabularies } from "./check-wire-unions.ts";

const vocabulary = deliveryVocabularies(`
export const DEPLOYMENT_STATES = ["success", "failure", "in_progress", "inactive", "unknown"] as const;
`);

describe("copiedWireUnions", () => {
	test("detects an anonymous stale nullable copy across lines", () => {
		expect(
			copiedWireUnions(
				`interface Response { state: "success" | "failure" |
 "in_progress" | "unknown" | null }`,
				vocabulary,
			),
		).toEqual([{ line: 1, name: "DEPLOYMENT_STATES" }]);
	});
	test("detects a renamed type copy", () => {
		expect(
			copiedWireUnions('type LocalState = "success" | "failure" | "in_progress";', vocabulary),
		).toHaveLength(1);
	});
	test("allows canonical references and unrelated unions", () => {
		expect(
			copiedWireUnions(
				'interface Response { state: DeploymentState | null; kind: "one" | "two" | "three" }',
				vocabulary,
			),
		).toEqual([]);
	});
	test("ignores union examples inside quoted and template documentation", () => {
		const example = 'state: "success" | "failure" | "in_progress"';
		for (const quoted of [JSON.stringify(example), `\`${example}\``])
			expect(copiedWireUnions(`const documentation = ${quoted};`, vocabulary)).toEqual([]);
	});
	test("ignores string literals in expressions and comments", () => {
		expect(
			copiedWireUnions(
				'// "success" | "failure" | "in_progress"\nconst values = ["success", "failure", "in_progress"];',
				vocabulary,
			),
		).toEqual([]);
	});
});
