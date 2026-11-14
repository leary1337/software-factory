import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReviewFinding } from "../../core/review-findings.ts";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { createGitFixture } from "../../workspace/git/test-fixture.ts";
import { runHostProcess } from "./process-spawn.ts";
import { runIndependentQualityGate } from "./quality-gate.ts";
import { LocalRunStore } from "./run-store.ts";

async function setup(
	script: string,
	assets: Readonly<Record<string, string>> = {},
	findings?: ReviewFinding[],
) {
	const fixture = await createGitFixture({ prefix: "factory-gate-process-", initCommit: "base" });
	const git = async (...args: string[]) => {
		const result = await fixture.git(args);
		if (result.exitCode !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	await writeFile(join(fixture.path, "check.sh"), script);
	for (const [path, content] of Object.entries(assets)) {
		await mkdir(dirname(join(fixture.path, path)), { recursive: true });
		await writeFile(join(fixture.path, path), content);
	}
	await git("add", ".");
	await git("commit", "-qm", "gate source");
	const commit = await git("rev-parse", "HEAD");
	const workspace = join(fixture.root, "reviewer");
	const home = join(fixture.root, "reviewer-home");
	await mkdir(workspace);
	await mkdir(home);
	await writeFile(join(home, "auth.json"), "reviewer credential");
	if (findings)
		await writeFile(join(home, "warren-review.json"), JSON.stringify({ version: 1, findings }));
	const profile: SandboxProfile = {
		workspace,
		home,
		network: "none",
		readOnlyMounts: [],
		allowedDomains: [],
		envPassthrough: ["OPENAI_API_KEY"],
		setEnv: { WARREN_API_TOKEN: "callback-secret" },
		toolchainPaths: [dirname(process.execPath), dirname(Bun.which("bun") ?? process.execPath)],
		timeoutMs: 5000,
		workspaceGit: {
			gitDir: join(workspace, ".git"),
			hostGitDir: join(fixture.path, ".git"),
			sharedObjects: join(fixture.path, ".git/objects"),
			protectedPaths: [],
			deniedRoots: [],
		},
	};
	const store = new LocalRunStore();
	const record = store.create({
		runId: "real-gate",
		sandboxId: "real-gate",
		workspacePath: workspace,
		homePath: home,
		branch: "test",
	});
	return {
		fixture,
		profile,
		commit,
		record,
		git,
		run: () =>
			runIndependentQualityGate(
				store,
				record,
				{ command: "sh check.sh", commit, ...(findings ? { reviewFindings: [] } : {}) },
				profile,
				{ CODEX_HOME: home },
				{ spawn: runHostProcess },
			),
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("Gate process did not reach the expected state");
}

describe.skipIf(process.platform !== "darwin")("independent gate as a host process", () => {
	test("prepares the clean verification copy before checking its pinned sources", async () => {
		const h = await setup("test -f node_modules/ready && test ! -f skipped");
		try {
			const store = new LocalRunStore();
			await runIndependentQualityGate(
				store,
				h.record,
				{
					command: "sh check.sh",
					commit: h.commit,
					preparation: {
						recipe: "command",
						command: "mkdir node_modules; touch node_modules/ready",
					},
				},
				h.profile,
				undefined,
				{ spawn: runHostProcess },
			);
			expect(
				h.record.events.filter((e) => e.kind.startsWith("preparation.")).map((e) => e.kind),
			).toEqual(["preparation.started", "preparation.completed"]);
			expect(
				h.record.events.find((e) => e.kind === "quality_gate.completed")?.payload,
			).toMatchObject({ commit: h.commit, exitCode: 0 });
		} finally {
			await h.fixture.cleanup();
		}
	});

	test("uses the pinned commit with fresh HOME and dependencies, preserving its SHA witness", async () => {
		const h = await setup(
			'set -e\ntest ! -e "$HOME/auth.json"\ntest -z "$WARREN_API_TOKEN"\ntest ! -e node_modules/poison\ntest "$(cat source.txt)" = committed\necho FRESH_GATE_OK\n',
			{ "source.txt": "committed\n" },
		);
		try {
			await mkdir(join(h.profile.workspace, "node_modules"));
			await writeFile(join(h.profile.workspace, "node_modules/poison"), "poison");
			await writeFile(join(h.profile.workspace, "source.txt"), "dirty");
			await writeFile(join(h.fixture.path, "source.txt"), "dirty host clone");
			await h.run();
			expect(h.record.events.at(-1)).toMatchObject({
				kind: "quality_gate.completed",
				payload: { commit: h.commit, exitCode: 0, stdout: "FRESH_GATE_OK\n" },
			});
			expect(
				(await readdir(h.fixture.root)).filter((name) => name.startsWith(".quality-gate-")),
			).toEqual([]);
		} finally {
			await h.fixture.cleanup();
		}
	});

	for (const [label, script, error] of [
		["source mutation", "echo changed > check.sh\nexit 0\n", "changed reviewed source"],
		["failed check", "exit 7\n", "exit 7"],
	] as const) {
		test(`refuses a PASS after ${label}`, async () => {
			const h = await setup(script);
			try {
				await expect(h.run()).rejects.toThrow(error);
				expect(
					h.record.events.some(
						(event) =>
							event.kind === "quality_gate.completed" &&
							(event.payload as { exitCode: number }).exitCode === 0,
					),
				).toBe(false);
			} finally {
				await h.fixture.cleanup();
			}
		});
	}

	for (const operation of ["cancel", "timeout"] as const) {
		test(`kills descendants and produces no PASS after gate ${operation}`, async () => {
			const h = await setup('sleep 30 & echo $! > "$WARREN_PROJECT_INPUTS/child.pid"\nwait\n');
			try {
				h.profile.projectInputsPath = h.fixture.root;
				h.profile.timeoutMs = 500;
				const running = h.run();
				const outcome = running.then(
					() => undefined,
					(error) => error as Error,
				);
				const pidFile = join(h.fixture.root, "child.pid");
				await waitFor(() => Bun.file(pidFile).exists());
				const pid = Number(await readFile(pidFile, "utf8"));
				if (operation === "cancel") {
					h.record.cancelRequested = true;
					h.record.proc?.cancel();
				}
				expect((await outcome)?.message).toContain("cancelled or timed out");
				await waitFor(async () => !alive(pid));
				expect(h.record.events.some((event) => event.kind === "quality_gate.completed")).toBe(
					false,
				);
			} finally {
				await h.fixture.cleanup();
			}
		});
	}
});
