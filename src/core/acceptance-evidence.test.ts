import { describe, expect, test } from "bun:test";
import { parseAcceptanceCriteria, readAcceptanceSummary } from "./acceptance-evidence.ts";

describe("parseAcceptanceCriteria", () => {
	test("extracts explicit task criteria without treating other checklist items as acceptance", () => {
		expect(
			parseAcceptanceCriteria(
				"- [ ] ignored\n## Acceptance criteria\n- [ ] [check: login] Sign in\n- [x] Show errors\n## Notes\n- [ ] ignored",
			),
		).toEqual([
			{ criterion: "Sign in", checkId: "login" },
			{ criterion: "Show errors", checkId: null },
		]);
		expect(parseAcceptanceCriteria("## Критерии приёмки\n- [ ] Поиск работает")).toEqual([
			{ criterion: "Поиск работает", checkId: null },
		]);
	});
});

describe("readAcceptanceSummary", () => {
	test("accepts only the latest matching runtime receipt and invalidates an interrupted repeat", () => {
		const commit = "a".repeat(40);
		const payloadJson = { commit, criteria: [], verified: false, enforced: false };
		const event = { kind: "acceptance.completed", stream: "system", payloadJson };
		expect(readAcceptanceSummary([event], commit)).toEqual(payloadJson);
		expect(readAcceptanceSummary([event], "b".repeat(40))).toBeUndefined();
		expect(readAcceptanceSummary([{ ...event, stream: "stdout" }], commit)).toBeUndefined();
		expect(
			readAcceptanceSummary([event, { ...event, kind: "acceptance.started" }], commit),
		).toBeUndefined();
	});
});
