import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { VerdictStore } from "./verdict-store.ts";
import type { JudgeVerdict } from "./wire.ts";

function makeVerdict(overrides?: {
	runId?: string;
	rubricVersion?: string;
	model?: string;
}): JudgeVerdict {
	return {
		runId: overrides?.runId ?? "run-1",
		assignments: [
			{
				class: "spin_loop",
				confidence: "high",
				evidence: [{ fromSeq: 10, toSeq: 42 }],
				note: "repeated the same failing command",
			},
		],
		provenance: {
			provider: "anthropic",
			model: overrides?.model ?? "cheap-model",
			rubricVersion: overrides?.rubricVersion ?? "rubric-v1-abc",
			judgedAt: "2026-08-15T12:00:00.000Z",
		},
	};
}

function makeStore(): VerdictStore {
	return new VerdictStore(":memory:", { now: () => new Date("2026-08-15T12:00:00.000Z") });
}

describe("VerdictStore.recordVerdict", () => {
	test("appends a validated verdict and returns its rowid", () => {
		const store = makeStore();
		const id = store.recordVerdict(makeVerdict());
		expect(id).toBe(1);
		expect(store.count()).toBe(1);
		store.close();
	});

	test("rejects an invalid verdict before touching the DB", () => {
		const store = makeStore();
		expect(() => store.recordVerdict({ runId: "run-1", assignments: [] })).toThrow(
			/assignments/,
		);
		expect(store.count()).toBe(0);
		store.close();
	});

	test("rejects a verdict whose non-clean class carries no evidence", () => {
		const store = makeStore();
		const bad = makeVerdict();
		(bad.assignments[0] as { evidence: unknown }).evidence = [];
		expect(() => store.recordVerdict(bad)).toThrow(/evidence/);
		expect(store.count()).toBe(0);
		store.close();
	});

	test("replay of the same (runId, rubricVersion, judgeModelId) is a no-op", () => {
		const store = makeStore();
		const first = store.recordVerdict(makeVerdict());
		const second = store.recordVerdict(makeVerdict());
		expect(first).toBe(1);
		expect(second).toBeNull();
		expect(store.count()).toBe(1);
		expect(store.maxId()).toBe(1);
		store.close();
	});

	test("a re-judge under a new rubric version appends and never overwrites", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ rubricVersion: "rubric-v1-abc" }));
		const id = store.recordVerdict(makeVerdict({ rubricVersion: "rubric-v2-def" }));
		expect(id).toBe(2);
		expect(store.count()).toBe(2);
		const rows = store.rowsForRun("run-1");
		expect(rows.map((r) => r.rubricVersion)).toEqual(["rubric-v1-abc", "rubric-v2-def"]);
		store.close();
	});

	test("a re-judge by a different model under the same rubric appends", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ model: "cheap-model" }));
		const id = store.recordVerdict(makeVerdict({ model: "strong-model" }));
		expect(id).toBe(2);
		store.close();
	});
});

describe("VerdictStore.recordUnjudged", () => {
	test("appends an unjudged marker with a reason and detail", () => {
		const store = makeStore();
		const id = store.recordUnjudged({
			runId: "run-1",
			rubricVersion: "rubric-v1-abc",
			judgeModelId: "cheap-model",
			reason: "malformed_verdict",
			detail: "exhausted verdict attempts",
		});
		expect(id).toBe(1);
		const row = store.rowsForRun("run-1")[0];
		expect(row?.kind).toBe("unjudged");
		expect(row?.verdict).toBeNull();
		store.close();
	});

	test("defaults detail to null when omitted", () => {
		const store = makeStore();
		store.recordUnjudged({
			runId: "run-1",
			rubricVersion: "rubric-v1-abc",
			judgeModelId: "cheap-model",
			reason: "judge_error",
		});
		const row = store.rowsForRun("run-1")[0];
		expect(row?.kind).toBe("unjudged");
		expect(row?.detail).toBeNull();
		store.close();
	});

	test("migrates existing database schema missing the detail column", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "verdict-store-test-"));
		const dbPath = join(tmpDir, "legacy.db");
		let store: VerdictStore | undefined;
		try {
			const db = new Database(dbPath);
			db.run(`
				CREATE TABLE verdict_rows (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					kind TEXT NOT NULL CHECK (kind IN ('verdict', 'unjudged')),
					run_id TEXT NOT NULL,
					rubric_version TEXT NOT NULL,
					judge_model_id TEXT NOT NULL,
					verdict TEXT,
					reason TEXT,
					recorded_at TEXT NOT NULL,
					dedupe_key TEXT NOT NULL UNIQUE
				);
			`);
			// A pre-migration row: the real upgrade input is a populated
			// legacy file, not an empty table.
			db.run(
				`INSERT INTO verdict_rows
					(kind, run_id, rubric_version, judge_model_id, verdict, reason, recorded_at, dedupe_key)
				 VALUES ('unjudged', 'run-old', 'rubric-v1-abc', 'cheap-model', NULL, 'judge_error',
					'2026-08-01T00:00:00.000Z', 'run-old|rubric-v1-abc|cheap-model')`,
			);
			db.close();

			store = new VerdictStore(dbPath);
			const legacy = store.rowsForRun("run-old")[0];
			expect(legacy?.kind).toBe("unjudged");
			expect(legacy?.detail).toBeNull();

			const id = store.recordUnjudged({
				runId: "run-legacy",
				rubricVersion: "rubric-v1-abc",
				judgeModelId: "cheap-model",
				reason: "judge_error",
				detail: "legacy db detail test",
			});
			expect(id).toBe(2);
			const row = store.rowsForRun("run-legacy")[0];
			expect(row?.kind).toBe("unjudged");
			expect(row?.detail).toBe("legacy db detail test");
		} finally {
			store?.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("replay of the same unjudged marker is a no-op", () => {
		const store = makeStore();
		const opts = {
			runId: "run-1",
			rubricVersion: "rubric-v1-abc",
			judgeModelId: "cheap-model",
			reason: "malformed_verdict" as const,
		};
		expect(store.recordUnjudged(opts)).toBe(1);
		expect(store.recordUnjudged(opts)).toBeNull();
		expect(store.count()).toBe(1);
		store.close();
	});

	test("rejects an unknown reason", () => {
		const store = makeStore();
		expect(() =>
			store.recordUnjudged({
				runId: "run-1",
				rubricVersion: "rubric-v1-abc",
				judgeModelId: "cheap-model",
				// @ts-expect-error — deliberately outside the closed reason set
				reason: "whatever",
			}),
		).toThrow(/reason/);
		expect(store.count()).toBe(0);
		store.close();
	});
});

describe("VerdictStore paging and per-rubric reads", () => {
	test("rowsSince pages by rowid, oldest first", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ runId: "run-1" }));
		store.recordVerdict(makeVerdict({ runId: "run-2" }));
		store.recordVerdict(makeVerdict({ runId: "run-3" }));
		const page = store.rowsSince(1, 2);
		expect(page.map((r) => r.runId)).toEqual(["run-2", "run-3"]);
		expect(store.rowsSince(3, 10)).toEqual([]);
		expect(store.maxId()).toBe(3);
		store.close();
	});

	test("rowsForRubricVersion returns only that version's rows in append order", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ runId: "run-1", rubricVersion: "v1" }));
		store.recordVerdict(makeVerdict({ runId: "run-2", rubricVersion: "v2" }));
		store.recordVerdict(makeVerdict({ runId: "run-3", rubricVersion: "v1" }));
		const rows = store.rowsForRubricVersion("v1");
		expect(rows.map((r) => r.runId)).toEqual(["run-1", "run-3"]);
		store.close();
	});

	test("a stored verdict round-trips through the store with full fidelity", () => {
		const store = makeStore();
		const verdict = makeVerdict();
		store.recordVerdict(verdict);
		const row = store.rowsForRun("run-1")[0];
		expect(row?.kind).toBe("verdict");
		expect(row?.verdict).toEqual(verdict);
		expect(row?.judgeModelId).toBe("cheap-model");
		expect(row?.detail).toBeNull();
		store.close();
	});
});

describe("VerdictStore.calibrationPairs", () => {
	test("pairs cheap and strong verdicts for the same runId + rubricVersion", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ runId: "run-1", model: "cheap-model" }));
		store.recordVerdict(makeVerdict({ runId: "run-1", model: "strong-model" }));
		store.recordVerdict(makeVerdict({ runId: "run-2", model: "cheap-model" }));
		const pairs = store.calibrationPairs("rubric-v1-abc", "cheap-model", "strong-model");
		expect(pairs).toHaveLength(1);
		expect(pairs[0]?.runId).toBe("run-1");
		expect(pairs[0]?.cheap.provenance.model).toBe("cheap-model");
		expect(pairs[0]?.strong.provenance.model).toBe("strong-model");
		store.close();
	});

	test("never mixes rubric versions in the join", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ runId: "run-1", model: "cheap-model", rubricVersion: "v1" }));
		store.recordVerdict(makeVerdict({ runId: "run-1", model: "strong-model", rubricVersion: "v2" }));
		expect(store.calibrationPairs("v1", "cheap-model", "strong-model")).toEqual([]);
		store.close();
	});

	test("unjudged markers never join", () => {
		const store = makeStore();
		store.recordVerdict(makeVerdict({ runId: "run-1", model: "cheap-model" }));
		store.recordUnjudged({
			runId: "run-1",
			rubricVersion: "rubric-v1-abc",
			judgeModelId: "strong-model",
			reason: "judge_error",
		});
		expect(store.calibrationPairs("rubric-v1-abc", "cheap-model", "strong-model")).toEqual([]);
		store.close();
	});
});

describe("retired monetary storage", () => {
	test("removes the ledger and monetary provenance while preserving verdict history", () => {
		const dir = mkdtempSync(join(tmpdir(), "judge-retire-costs-"));
		const path = join(dir, "judge.db");
		try {
			const original = new VerdictStore(path);
			original.recordVerdict(makeVerdict());
			original.recordUnjudged({ runId: "run-2", rubricVersion: "v1", judgeModelId: "model", reason: "judge_error" });
			original.close();
			const raw = new Database(path);
			raw.exec("CREATE TABLE judge_spend (cost_usd REAL); INSERT INTO judge_spend VALUES (1.5)");
			raw.exec("UPDATE verdict_rows SET verdict = json_set(verdict, '$.provenance.costUsd', 1.5) WHERE kind = 'verdict'");
			raw.exec("UPDATE verdict_rows SET reason = 'budget_exceeded' WHERE kind = 'unjudged'");
			raw.close();
			const migrated = new VerdictStore(path);
			expect(migrated.count()).toBe(2);
			expect(migrated.rowsForRun("run-1")[0]).toMatchObject({ verdict: makeVerdict() });
			expect(migrated.rowsForRun("run-2")[0]).toMatchObject({ kind: "unjudged", reason: "judge_error" });
			migrated.close();
			const check = new Database(path);
			expect(check.query("SELECT name FROM sqlite_master WHERE name = 'judge_spend'").all()).toEqual([]);
			expect(check.query("SELECT json_extract(verdict, '$.provenance.costUsd') AS cost FROM verdict_rows WHERE kind = 'verdict'").get()).toEqual({ cost: null });
			check.close();
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
