import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PostgresWarrenDb } from "../client.ts";
import { isPostgresTestEnabled, withDb } from "../testing.ts";

describe("drop monetary accounting", () => {
	test("preserves existing runs, token usage, plans and dispatch context", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE runs (id TEXT PRIMARY KEY, state TEXT, tokens_input INTEGER, cost_usd REAL, cost_basis TEXT);
				INSERT INTO runs VALUES ('run-1', 'succeeded', 123, 1.5, 'subscription_estimate');
				CREATE TABLE plan_runs (id TEXT PRIMARY KEY, max_runs INTEGER, max_cost_usd REAL);
				INSERT INTO plan_runs VALUES ('plan-1', 3, 10);
				CREATE TABLE dispatch_context (run_id TEXT PRIMARY KEY, prompt_bytes INTEGER, cap_source TEXT, max_cost_usd REAL);
				INSERT INTO dispatch_context VALUES ('run-1', 42, 'project', 5);
			`);
			const sql = readFileSync(new URL("./0058_confused_mandarin.sql", import.meta.url), "utf8");
			for (const statement of sql.split("--> statement-breakpoint")) db.exec(statement);
			expect(db.query("SELECT * FROM runs").all()).toEqual([
				{ id: "run-1", state: "succeeded", tokens_input: 123 },
			]);
			expect(db.query("SELECT * FROM plan_runs").all()).toEqual([{ id: "plan-1", max_runs: 3 }]);
			expect(db.query("SELECT * FROM dispatch_context").all()).toEqual([
				{ run_id: "run-1", prompt_bytes: 42 },
			]);
		} finally {
			db.close();
		}
	});

	test.skipIf(!isPostgresTestEnabled())("removes monetary columns on Postgres", async () => {
		await using handle = await withDb({ dialect: "postgres" });
		const db = handle.db as PostgresWarrenDb;
		const result = await db.raw.query(`SELECT column_name FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name IN ('runs', 'plan_runs', 'dispatch_context')
			AND column_name IN ('cost_usd', 'cost_basis', 'max_cost_usd', 'cap_source')`);
		expect(result.rows).toHaveLength(0);
	});
});
