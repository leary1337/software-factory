/**
 * `/readyz` runtime-topology scoping (warren-c128). The bwrap and
 * stale-burrow-workspace probes only make sense for the local backend, where
 * warren runs sandboxes in-process on the host. Under `WARREN_RUNTIME=k8s`
 * agents run in pods and bwrap lives in the agent image, so those probes must
 * be scoped out of readiness rather than reporting "bwrap not found" and
 * degrading an otherwise-healthy control plane. The burrow-daemon socket probe
 * died with the daemon (warren-9a26) — there is no `burrow_reachable` check on
 * either topology anymore.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import type { RouteContext, ServerDeps } from "../types.ts";
import { readyzHandler } from "./diagnostics.ts";

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Spawn stub that fails `bwrap --version` (host has no bubblewrap). */
const failBwrap: SpawnFn = async (cmd) => {
	if (cmd[0]?.endsWith("bwrap")) return { stdout: "", stderr: "not found", exitCode: 127 };
	return { stdout: "", stderr: "", exitCode: 0 };
};

interface ReadyzProbe {
	status: number;
	names: string[];
	ok: boolean;
	checks: { name: string; ok: boolean; message?: string; hint?: string }[];
}

async function readyzChecks(
	db: WarrenDb,
	k8sPodSync?: { isSynced(): boolean },
	spawn: SpawnFn = failBwrap,
): Promise<ReadyzProbe> {
	const repos = createRepos(db);
	await repos.agents.upsert({
		name: "refactor-bot",
		renderedJson: { name: "refactor-bot", sections: { system: "x" } },
	});
	const deps = {
		repos,
		db,
		spawn,
		// Pin the probe to Linux semantics: checkBwrap self-skips on non-Linux
		// platforms, so without this the "no bwrap ⇒ 503" premise only holds
		// on Linux hosts and the test flips green/red by machine (warren-4de5).
		platform: "linux" satisfies NodeJS.Platform,
		projectsConfig: { root: "/tmp/projects", gitBinary: "git" },
		logger: silentLogger,
		uiDistDir: null,
		...(k8sPodSync !== undefined ? { k8sPodSync } : {}),
	} as unknown as ServerDeps;
	const res = await readyzHandler(deps)({} as RouteContext);
	const body = (await res.json()) as { ok: boolean; checks: ReadyzProbe["checks"] };
	return {
		status: res.status,
		ok: body.ok,
		names: body.checks.map((c) => c.name),
		checks: body.checks,
	};
}

describe("/readyz runtime-topology scoping (warren-c128)", () => {
	const prev = process.env.WARREN_RUNTIME;
	let db: WarrenDb | null = null;

	afterEach(async () => {
		if (prev === undefined) delete process.env.WARREN_RUNTIME;
		else process.env.WARREN_RUNTIME = prev;
		await db?.close();
		db = null;
	});

	test("reports readiness without any sandbox executable", async () => {
		process.env.WARREN_RUNTIME = "local";
		db = await openDatabase({ path: ":memory:" });
		const { status, names } = await readyzChecks(db);
		expect(status).toBe(200);
		expect(names).not.toContain("bwrap");
		expect(names).not.toContain("burrow_reachable");
		// The docker probe is scoped to the docker topology (warren-5c42).
		expect(names).not.toContain("docker_cli");
	});
});
