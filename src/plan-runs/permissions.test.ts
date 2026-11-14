import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { approvedFixture } from "./approval-test-helpers.ts";
import { planPermissionDecision } from "./permissions.ts";

let fixture: Awaited<ReturnType<typeof approvedFixture>>;
beforeEach(async () => {
	fixture = await approvedFixture();
});
afterEach(async () => {
	await fixture.dispose();
});
describe("approved change boundaries", () => {
	test("allows ordinary code, dependencies and workflow builds next to unchanged permission context", () => {
		const paths = [
			"src/application.ts",
			"package.json",
			".github/workflows/check.yml",
			"migrations/add.sql",
		];
		const diff =
			"diff --git a/.github/workflows/check.yml b/.github/workflows/check.yml\n permissions: read-all\n-run: old\n+run: new\ndiff --git a/migrations/add.sql b/migrations/add.sql\n DROP TABLE historical;\n+CREATE TABLE new_table (id TEXT);";
		expect(planPermissionDecision(fixture.approval.snapshot, 1, paths, diff).blocked).toEqual([]);
	});
	test("blocks special changes until exact scope and reason are saved", () => {
		const paths = [
			"src/auth/policy.ts",
			"AGENTS.md",
			"migrations/002.sql",
			".github/workflows/check.yml",
		];
		const diff =
			"diff --git a/migrations/002.sql b/migrations/002.sql\n+DROP TABLE accounts;\ndiff --git a/.github/workflows/check.yml b/.github/workflows/check.yml\n+permissions: write-all";
		const blocked = planPermissionDecision(fixture.approval.snapshot, 1, paths, diff);
		expect(blocked.blocked.map((value) => value.kind)).toEqual([
			"access",
			"factory_rules",
			"destructive_migration",
			"access",
		]);
		const snapshot = structuredClone(fixture.approval.snapshot);
		snapshot.permissions = [
			{ kind: "access", paths: ["src/auth/**"], reason: "Approved authorization change" },
		];
		expect(planPermissionDecision(snapshot, 1, paths, diff).blocked).toHaveLength(3);
		snapshot.permissions = snapshot.permissions.map((permission) => ({
			...permission,
			reason: "",
		}));
		expect(planPermissionDecision(snapshot, 1, paths, diff).blocked).toHaveLength(4);
	});
});
