import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Layout guard for the repro-first convention (warren-9fd7). Each UI bug
 * gets one `repros/<seed-id>.pw.ts` that the ui-visual harness runs. The
 * `.pw.ts` suffix matters: `bun test` loads any `.spec.ts`, and a
 * Playwright spec loaded there fails the root suite.
 */

const REPROS = join(import.meta.dir, "repros");
const REPRO_FILE = /^(warren-[0-9a-f]{4,})\.pw\.ts$/;
/** playwright.config.ts `testMatch`. */
const PW_TEST_MATCH = /.*\.pw\.ts$/;

describe("ui-visual repros", () => {
	const entries = readdirSync(REPROS, { withFileTypes: true });

	test("holds at least the worked example", () => {
		expect(entries.map((e) => e.name)).toContain("warren-e9cd.pw.ts");
	});

	test("names every file <seed-id>.pw.ts so Playwright, not bun test, runs it", () => {
		const bad = entries
			.filter((e) => !e.isFile() || !REPRO_FILE.test(e.name) || !PW_TEST_MATCH.test(e.name))
			.map((e) => e.name);
		expect(bad).toEqual([]);
	});

	test("names its seed in each repro's source", () => {
		const unnamed = entries.flatMap((e) => {
			const seed = REPRO_FILE.exec(e.name)?.[1];
			if (seed === undefined) return [];
			return readFileSync(join(REPROS, e.name), "utf8").includes(seed) ? [] : [e.name];
		});
		expect(unnamed).toEqual([]);
	});
});
