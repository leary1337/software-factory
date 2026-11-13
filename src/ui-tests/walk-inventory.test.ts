/** Source-boundary checks for the plan inventory. Rendered behavior lives in
 * scripts/ui-visual/repros/warren-f102.pw.ts (warren-f102). */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_PAGES = join(import.meta.dir, "..", "ui", "src", "pages");
const read = (file: string): string => readFileSync(join(UI_PAGES, file), "utf8");
const PAGE = read("plan-runs.tsx");
const ROW = read("plan-runs/walk-row.tsx");
const STATE = read("plan-runs/walk-state.ts");

describe("Plan runs walk inventory (warren-23b2 / pl-7e38 step 6)", () => {
	test("keeps the existing plan-runs list API as its data source", () => {
		expect(PAGE).toMatch(/planRunsApi\.list\(/);
		// Server-side filters, not a client re-implementation of them.
		expect(PAGE).toMatch(/state: stateFilter/);
		expect(PAGE).toMatch(/project: projectFilter/);
	});

	test("the Dispatch plan control is gated for the spectator projection", () => {
		// The only operator affordance on a readPublic list: absent, not
		// disabled (warren-f53e).
		expect(PAGE).toMatch(/<OperatorOnly>\s*<Button asChild>\s*<Link\s+to="\/dispatch\/plan"/);
		expect(PAGE).toMatch(/useOperatorHint\(/);
	});

	test("theming uses token variables only — no hardcoded colors", () => {
		for (const source of [PAGE, ROW]) {
			// Any literal hex/rgb color reintroduces a theme that only
			// renders in one of dark or light.
			expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
			expect(source).not.toMatch(/rgb\(|rgba\(|oklch\(/);
		}
	});

	test("wire vocabulary is re-exported, never redeclared", () => {
		// PlanRunState / PlanRunChildState come from src/core/wire.ts via
		// @/api/types.ts (the check:wire-types guard owns the re-export
		// chain; this pins that the page never spells a local copy).
		expect(ROW).toMatch(/from "@\/api\/types\.ts"/);
		expect(ROW).not.toMatch(/export type PlanRun(State|ChildState) =/);
		expect(STATE).not.toMatch(/export type PlanRun(State|ChildState) =/);
	});
});
