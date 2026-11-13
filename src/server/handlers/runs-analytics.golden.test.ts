import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, NO_AUTH, silentLogger, tcpUrl } from "./runs.analytics.test-helpers.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

const PROJECT_ID = "project_golden_ea4e";
const RUN_API = "run_golden_ea4e_api";
const RUN_SUB = "run_golden_ea4e_sub";
const RUN_UNPRICED = "run_golden_ea4e_ghost";
const NOW = "2026-08-07T00:00:00.000Z";
// Pinned analytics window — the fixtures must not drift with the clock.
const WINDOW = "from=2026-08-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z";

interface Snapshot {
	readonly status: number;
	readonly body: unknown;
}

interface SeedSpec {
	readonly id: string;
	readonly state: "succeeded" | "failed" | "running";
}

async function seedAnalyticsRun(repos: Repos, s: SeedSpec): Promise<void> {
	await repos.runs.create({
		id: s.id,
		agentName: "claude-code",
		projectId: PROJECT_ID,
		prompt: "pin the analytics body",
		renderedAgentJson: { frontmatter: { provider: "anthropic", model: "sonnet" } },
		trigger: "manual",
		now: new Date(NOW),
	});
	await repos.runs.markRunning(s.id, new Date("2026-08-07T00:00:05.000Z"));

	// the read-time hydration (warren-b33e), so the unpriced bucket needs a
	// non-terminal run to survive.
	if (s.state === "running") return;
	await repos.runs.finalize(
		s.id,
		s.state,
		new Date("2026-08-07T00:05:00.000Z"),
		s.state === "failed" ? "crashed" : null,
	);
	await repos.runs.attachStats(s.id, {
		tokensInput: 1000,
		tokensCacheRead: 0,
		tokensOutput: 100,
		tokensCacheWrite: 0,
	});
}

describe("analytics GET bodies — __golden__ snapshots (warren-ea4e)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			id: PROJECT_ID,
			gitUrl: "https://github.com/os-eco/warren.git",
			localPath: "/data/projects/os-eco/warren",
			defaultBranch: "main",
		});

		// unpriced run that is still running — see seedAnalyticsRun.
		const seeds: readonly SeedSpec[] = [
			{ id: RUN_API, state: "succeeded" },
			{ id: RUN_SUB, state: "failed" },
			{ id: RUN_UNPRICED, state: "running" },
		];
		for (const s of seeds) await seedAnalyticsRun(repos, s);
		// Two budget.exceeded events — the capHits count's only source.
		for (const [runId, seq] of [
			[RUN_API, 1],
			[RUN_SUB, 2],
		] as const) {
			await repos.events.append({
				runId,
				sandboxEventSeq: seq,
				ts: "2026-08-07T00:04:00.000Z",
				kind: "budget.exceeded",
				stream: "system",
				payload: { costUsd: 2 },
			});
		}
		handle = startServer(depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function produce(path: string): Promise<Snapshot> {
		const res = await fetch(`${base}${path}`);
		return { status: res.status, body: await res.json() };
	}

	const cases: ReadonlyArray<{ name: string; path: string }> = [
		{ name: "analytics-runs", path: `/analytics/runs?${WINDOW}` },
	];

	if (UPDATE) {
		test("regenerate fixtures", async () => {
			if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
			for (const c of cases) {
				const path = join(GOLDEN_DIR, `${c.name}.json`);
				writeFileSync(path, `${JSON.stringify(await produce(c.path), null, "\t")}\n`);
			}
			expect(cases.length).toBeGreaterThan(0);
		});
		return;
	}

	for (const c of cases) {
		test(c.name, async () => {
			const path = join(GOLDEN_DIR, `${c.name}.json`);
			const expected = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
			expect(await produce(c.path)).toEqual(expected);
		});
	}
});
