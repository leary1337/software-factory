import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreparationRecipe } from "../core/preparation.ts";
import { runHostProcess } from "../runtime/local/process-spawn.ts";
import type { SandboxProfile } from "../sandbox/types.ts";
import type { ReserveEnvironmentRepair } from "./repair.ts";
import { type PreparationOwner, runPreparation } from "./run.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "prep-run-"));
	roots.push(root);
	const home = join(root, "homes", "run");
	const workspace = join(root, "workspace");
	await mkdir(home, { recursive: true });
	await mkdir(workspace);
	const profile: SandboxProfile = {
		workspace,
		home,
		network: "open",
		allowedDomains: [],
		readOnlyMounts: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [dirname(Bun.which("bun") ?? process.execPath)],
		timeoutMs: 5000,
	};
	const owner: PreparationOwner = { cancelRequested: false };
	const events: { kind: string; payload: Record<string, unknown> }[] = [];
	return {
		root,
		profile,
		owner,
		events,
		run: (config: PreparationRecipe, reserveEnvironmentRepair?: ReserveEnvironmentRepair) =>
			runPreparation({
				runId: "test-run",
				reserveEnvironmentRepair,
				profile,
				config,
				stage: "agent",
				runHome: home,
				owner,
				spawn: runHostProcess,
				emit: (kind, payload) => {
					events.push({ kind, payload });
				},
			}),
	};
}
describe.skipIf(process.platform !== "darwin")("runPreparation", () => {
	test("repairs a transient download within the task budget without replacing source work", async () => {
		const h = await setup();
		await writeFile(join(h.profile.workspace, "source"), "work in progress");
		let reserved = 0;
		await h.run(
			{
				recipe: "command",
				command:
					"if test ! -e attempted; then touch attempted; echo 'HTTP 503 temporary failure' >&2; exit 1; fi; test -f source",
			},
			async () => {
				reserved++;
			},
		);
		expect(reserved).toBe(1);
		expect(await readFile(join(h.profile.workspace, "source"), "utf8")).toBe("work in progress");
		expect(h.events.some((e) => e.kind === "preparation.repair_started")).toBe(true);
		expect(h.events.at(-1)?.kind).toBe("preparation.completed");
	});
	test("bounds identical transport failures and obeys exhausted task budgets", async () => {
		const h = await setup();
		let reserved = 0;
		const recipe: PreparationRecipe = {
			recipe: "command",
			command: "echo 'ECONNRESET' >&2; exit 1",
		};
		await expect(
			h.run(recipe, async () => {
				reserved++;
			}),
		).rejects.toThrow("limit exhausted");
		expect(reserved).toBe(2);
		expect(h.events.filter((e) => e.kind === "preparation.repair_started")).toHaveLength(2);
		await expect(
			h.run(recipe, async () => {
				throw new Error("Task repair budget exhausted");
			}),
		).rejects.toThrow("Task repair budget exhausted");
		await expect(
			h.run({ recipe: "command", command: "echo 'invalid lockfile' >&2; exit 1" }, async () => {
				throw new Error("Must not retry");
			}),
		).rejects.toThrow("invalid lockfile");
	});

	test("prepares with an explicit command and retains only download caches across copies", async () => {
		const h = await setup();
		try {
			const prepared = await h.run({
				recipe: "command",
				command: "mkdir node_modules; printf isolated > node_modules/fixture",
			});
			expect(await readFile(join(h.profile.workspace, "node_modules/fixture"), "utf8")).toBe(
				"isolated",
			);
			expect(prepared.setEnv.npm_config_cache).toBe(join(h.root, "download-cache/npm"));
			expect(h.events.at(-1)?.kind).toBe("preparation.completed");
			const second = join(h.root, "second");
			await mkdir(second);
			const another = await runPreparation({
				profile: { ...h.profile, workspace: second },
				config: {
					recipe: "command",
					command:
						"test ! -e node_modules; mkdir node_modules; printf second > node_modules/fixture",
				},
				stage: "verification",
				runHome: h.profile.home,
				owner: h.owner,
				spawn: runHostProcess,
				emit: () => {},
			});
			expect(another.setEnv.npm_config_cache).toBe(prepared.setEnv.npm_config_cache);
			expect(await readFile(join(h.profile.workspace, "node_modules/fixture"), "utf8")).toBe(
				"isolated",
			);
		} finally {
			h.owner.proc?.cancel();
		}
	});
	test("reports install and tool version failures as environment errors", async () => {
		const h = await setup();
		await expect(
			h.run({ recipe: "command", command: "echo dependency-unavailable >&2; exit 9" }),
		).rejects.toThrow("dependency-unavailable");
		expect(h.events.at(-1)).toMatchObject({
			kind: "preparation.failed",
			payload: { stage: "agent" },
		});
		await expect(
			h.run({ recipe: "command", command: "exit 0", tools: { bun: { version: "999.0" } } }),
		).rejects.toThrow("requires bun 999.0");
		await expect(
			h.run({ recipe: "command", command: "exit 0", tools: { go: { executable: "/missing/go" } } }),
		).rejects.toThrow("Environment preparation failed");
	});
	test("cancels and times out the preparation process tree", async () => {
		const h = await setup();
		const pidfile = join(h.profile.workspace, "child.pid");
		const running = h.run({ recipe: "command", command: "sleep 60 & echo $! > child.pid; wait" });
		for (let i = 0; i < 200 && !(await Bun.file(pidfile).exists()); i++) await Bun.sleep(10);
		const pid = Number(await readFile(pidfile, "utf8"));
		h.owner.cancelRequested = true;
		h.owner.proc?.cancel();
		await expect(running).rejects.toThrow("cancelled");
		expect(() => process.kill(pid, 0)).toThrow();
		h.owner.cancelRequested = false;
		await expect(
			h.run({ recipe: "command", command: "sleep 60 & wait", timeoutMs: 100 }),
		).rejects.toThrow("timed out");
	});
	test("installs a real frozen Bun lockfile in each clean workspace", async () => {
		const h = await setup();
		await mkdir(join(h.profile.workspace, "dep"));
		await writeFile(
			join(h.profile.workspace, "dep/package.json"),
			'{"name":"local-dep","version":"1.0.0"}',
		);
		await writeFile(
			join(h.profile.workspace, "package.json"),
			JSON.stringify({
				name: "fixture",
				version: "1.0.0",
				dependencies: { "local-dep": "file:./dep" },
				packageManager: `bun@${Bun.version}`,
			}),
		);
		const initial = Bun.spawn(
			[Bun.which("bun") ?? process.execPath, "install", "--lockfile-only"],
			{ cwd: h.profile.workspace, stdout: "pipe", stderr: "pipe" },
		);
		expect(await initial.exited).toBe(0);
		await h.run({ recipe: "javascript" });
		expect(h.events.at(-1)?.kind).toBe("preparation.completed");
		await writeFile(
			join(h.profile.workspace, "package.json"),
			'{"dependencies":{"definitely-not-in-lock":"1.0.0"}}',
		);
		await expect(h.run({ recipe: "javascript" })).rejects.toThrow("Environment preparation failed");
	});
});
