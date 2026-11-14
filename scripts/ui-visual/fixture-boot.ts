/**
 * Deterministic fixture boot for browser screenshots (warren-010b, plan
 * pl-10db step 7). The Playwright harness (warren-99e1) and the golden
 * screenshots (warren-a132) build on this file's output.
 *
 *   bun run scripts/ui-visual/fixture-boot.ts --json [--port 4517]
 *
 * Boots the real warren server in a child process (via the acceptance
 * harness's `bootInProc`) against a temp SQLite database seeded before
 * boot, prints ONE JSON line on stdout, then serves until SIGTERM/SIGINT,
 * when it stops warren, removes the temp root, and exits 0.
 *
 * ## Output contract (`FixtureBootOutput`)
 *
 *   {
 *     "baseUrl": "http://127.0.0.1:<port>",
 *     "token": "warren-ui-visual-fixture-token",   // fixed; seed localStorage
 *                                                  // `warren.apiToken` with it
 *     "frozenNow": "2026-09-15T12:00:00.000Z",     // server clock; pin the
 *     "frozenNowMs": 1789473600000,                // browser clock to it too
 *     "uiServed": true,                            // false when src/ui/dist is absent
 *     "tmpRoot": "/tmp/warren-ui-visual-…",
 *     "ids": FixtureIds
 *   }
 *
 * ## The ids contract (`FixtureIds`, every value a fixed literal)
 *
 *   projects.withSeeds      prj_fx0000000001  warren-acceptance/sample (hasSeeds, .seeds/ clone)
 *   projects.withoutSeeds   prj_fx0000000002  warren-acceptance/docs-site
 *   runs.queued             run_fx0000000101
 *   runs.running            run_fx0000000102  41 events (stdout/stderr/system, tool_use/
 *                                             tool_result/text/thinking/steer.sent)
 *   runs.succeeded          run_fx0000000103  no PR (report-only run)
 *   runs.failed             run_fx0000000104  failureReason = failedRunReason ("timed_out")
 *   runs.cancelled          run_fx0000000105
 *   runs.prOpen             run_fx0000000106  succeeded, pr_state "open"
 *   planRun.id              plnr_fx0000000001 running; 7 children: merged, merged, failed,
 *                                             pr_open, running, pending, skipped
 *   tracker.dispatchedPlanId "pl-fx01" (the plan-run's plan); tracker.readyPlanId "pl-fx02"
 *                           (approved, undispatched) — served by the fixture `sd` stub
 *   agents.builtin          the seven BUILTIN_AGENTS names (source "builtin")
 *   agents.legacyLibrary    "legacy-reviewer" (source "library")
 *   telemetry.historyRunIds run_fx0000000301..318: terminal runs over the last 14 days
 *                           with cost, tokens, PR outcomes, tool_calls, and steers;
 *
 * ## Determinism
 *
 * Every seeded timestamp derives from `FIXTURE_NOW_ISO`; the server runs
 * through `bootServer({ now })` with the clock pinned to it, so a window or
 * age computed server-side is stable. Relative labels the BROWSER computes
 * ("8m ago", telemetry from/to) are stable only once the harness pins the
 * page clock to `frozenNowMs` (Playwright `page.clock.setFixedTime`).
 * Background workers that would mutate seeded rows (scheduler, plan-run
 * coordinator, watchdog, workspace GC, preview eviction, forge heartbeat)
 * are disabled; the forge is the in-memory fake, so nothing reaches GitHub.
 *
 * ## Prerequisite for screenshots
 *
 * The SPA is served only when `src/ui/dist/index.html` exists: run
 * `bun run build:ui` first. Without it the API still boots (`uiServed:
 * false`), which is all the fixture test needs.
 *
 * The SPA uses a hash router: deep links are `${baseUrl}/#/runs/<id>`,
 * `${baseUrl}/#/plan-runs/<id>`, and so on. A bare `${baseUrl}/runs` hits
 * the JSON API (401 without a bearer), not the page.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSampleProject, FIXTURE_CONSTANTS } from "../acceptance/lib/fixtures.ts";
import { type BootHandle, bootInProc } from "../acceptance/lib/inproc.ts";
import {
	FIXTURE_NOW_ISO,
	FIXTURE_NOW_MS,
	FIXTURE_TOKEN,
	type FixtureIds,
	seedFixtureDb,
} from "./fixture-data.ts";
import { writeFixtureSdStub } from "./fixture-sd-stub.ts";

export interface FixtureBootOutput {
	readonly baseUrl: string;
	readonly token: string;
	readonly frozenNow: string;
	readonly frozenNowMs: number;
	readonly uiServed: boolean;
	readonly tmpRoot: string;
	readonly ids: FixtureIds;
}

export interface FixtureBootOptions {
	/** Bind port; default a random free-ish port (bootInProc's picker). */
	readonly port?: number;
	/** Built SPA dir; default `<repo>/src/ui/dist` when its index.html exists. */
	readonly uiDistDir?: string | null;
}

export interface FixtureBootHandle {
	readonly output: FixtureBootOutput;
	/** Stop warren and remove the temp root. Idempotent. */
	stop(): Promise<void>;
}

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SERVER_ENTRY = join(import.meta.dir, "fixture-server-entry.ts");

function defaultUiDistDir(): string | null {
	const dir = join(REPO_ROOT, "src", "ui", "dist");
	return existsSync(join(dir, "index.html")) ? dir : null;
}

/** Env that holds every background mutator off the seeded rows. */
function fixtureEnv(sdStubPath: string, uiDistDir: string | null) {
	return {
		WARREN_UI_VISUAL_NOW: String(FIXTURE_NOW_MS),
		WARREN_FORGE: "fake",
		WARREN_SD_BINARY: sdStubPath,
		WARREN_SCHEDULER_DISABLED: "1",
		WARREN_PLAN_RUN_DISABLED: "1",
		WARREN_WATCHDOG_DISABLED: "1",
		WARREN_WORKSPACE_GC_DISABLED: "1",
		WARREN_PREVIEW_EVICTION_DISABLED: "1",
		WARREN_FORGE_HEARTBEAT_DISABLED: "1",
		// Parallel Playwright workers share one token, and each page holds
		// the lifecycle stream (plus a run's event stream on run detail): the
		// default per-client cap of 5 would 503 them (warren-99e1).
		WARREN_MAX_EVENT_STREAMS_PER_CLIENT: "200",
		TZ: "UTC",
		...(uiDistDir !== null
			? { WARREN_DISABLE_UI: "0", WARREN_UI_DIST_DIR: uiDistDir }
			: { WARREN_DISABLE_UI: "1" }),
	};
}

/** Build the temp root, seed the database, and boot warren on it. */
export async function bootFixture(opts: FixtureBootOptions = {}): Promise<FixtureBootHandle> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "warren-ui-visual-"));
	const projectsDir = join(tmpRoot, "data", "projects", FIXTURE_CONSTANTS.projectOwner);
	const seedsProjectPath = join(projectsDir, FIXTURE_CONSTANTS.projectRepo);
	const plainProjectPath = join(projectsDir, "docs-site");
	let boot: BootHandle | undefined;
	const stop = async (): Promise<void> => {
		const b = boot;
		boot = undefined;
		if (b !== undefined) await b.stop();
		await rm(tmpRoot, { recursive: true, force: true });
	};
	try {
		await mkdir(seedsProjectPath, { recursive: true });
		await buildSampleProject(seedsProjectPath);
		await mkdir(plainProjectPath, { recursive: true });
		await writeFile(join(plainProjectPath, "README.md"), "# docs-site\n\nFixture project.\n");
		const seeded = await seedFixtureDb({
			dbPath: join(tmpRoot, "data", "warren.db"),
			seedsProjectPath,
			plainProjectPath,
		});
		const uiDistDir = opts.uiDistDir === undefined ? defaultUiDistDir() : opts.uiDistDir;
		boot = await bootInProc({
			tmpRoot,
			token: FIXTURE_TOKEN,
			canopyRepoUrl: `https://github.com/${FIXTURE_CONSTANTS.canopyOwner}/${FIXTURE_CONSTANTS.canopyRepo}.git`,
			serverEntry: SERVER_ENTRY,
			...(opts.port !== undefined ? { bind: { host: "127.0.0.1", port: opts.port } } : {}),
			extraEnv: fixtureEnv(await writeFixtureSdStub(tmpRoot), uiDistDir),
		});
		return {
			output: {
				baseUrl: boot.warrenUrl,
				token: FIXTURE_TOKEN,
				frozenNow: FIXTURE_NOW_ISO,
				frozenNowMs: FIXTURE_NOW_MS,
				uiServed: uiDistDir !== null,
				tmpRoot,
				ids: seeded.ids,
			},
			stop,
		};
	} catch (err) {
		await stop();
		throw err;
	}
}

function parsePort(argv: readonly string[]): number | undefined {
	const i = argv.indexOf("--port");
	if (i === -1) return undefined;
	const port = Number(argv[i + 1]);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`--port needs an integer in 1..65535; got '${argv[i + 1] ?? ""}'`);
	}
	return port;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const handle = await bootFixture({
		...(parsePort(argv) !== undefined ? { port: parsePort(argv) } : {}),
	});
	const json = argv.includes("--json");
	console.log(json ? JSON.stringify(handle.output) : JSON.stringify(handle.output, null, 2));
	if (!json) {
		const ui = handle.output.uiServed ? "" : " (API only: run `bun run build:ui` to serve the SPA)";
		console.error(`ui-visual fixture ready at ${handle.output.baseUrl}${ui}; Ctrl-C to stop`);
	}
	const shutdown = (): void => {
		handle.stop().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}
