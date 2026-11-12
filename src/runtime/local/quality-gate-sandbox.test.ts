import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runSandboxed } from "../../sandbox/sandbox.ts";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { createGitFixture } from "../../workspace/git/test-fixture.ts";
import { runIndependentQualityGate } from "./quality-gate.ts";
import { prepareQualityGateWorkspace } from "./quality-gate-workspace.ts";
import { LocalRunStore } from "./run-store.ts";

async function setup(script: string, assets: Readonly<Record<string, string>> = {}) {
	const fixture = await createGitFixture({ prefix: "factory-gate-sandbox-", initCommit: "base" });
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
				{ command: "sh check.sh", commit },
				profile,
				{ CODEX_HOME: home },
				{ spawn: runSandboxed },
			),
	};
}

describe("prepareQualityGateWorkspace", () => {
	test("retains only host-provisioned project inputs in the credential-free gate", async () => {
		const h = await setup("exit 0\n");
		try {
			const inputs = join(h.fixture.root, "trusted-inputs");
			await mkdir(inputs);
			h.profile.projectInputsPath = inputs;
			h.profile.readOnlyMounts = [inputs, h.profile.home];
			const fresh = await prepareQualityGateWorkspace(h.profile, h.commit);
			try {
				expect(fresh.profile.readOnlyMounts).toEqual([inputs]);
				expect(fresh.profile.setEnv.WARREN_PROJECT_INPUTS).toBe(inputs);
				expect(fresh.profile.workspaceGit?.deniedRoots).not.toContain(inputs);
				expect(fresh.profile.setEnv.WARREN_API_TOKEN).toBeUndefined();
			} finally {
				await fresh.cleanup();
			}
		} finally {
			await h.fixture.cleanup();
		}
	});

	test("fails closed without trusted host objects", async () => {
		await expect(prepareQualityGateWorkspace({} as SandboxProfile, "a".repeat(40))).rejects.toThrow(
			"trusted host Git objects",
		);
	});
	test("uses committed objects and verifies source without a mutable index", async () => {
		const h = await setup("exit 9\n");
		try {
			await writeFile(join(h.profile.workspace, "check.sh"), "exit 0\n");
			const fresh = await prepareQualityGateWorkspace(h.profile, h.commit);
			try {
				expect(await Bun.file(join(fresh.profile.workspace, "check.sh")).text()).toBe("exit 9\n");
				expect(fresh.profile.envPassthrough).toEqual([]);
				expect(fresh.profile.setEnv.WARREN_API_TOKEN).toBeUndefined();
				await fresh.verify();
				await writeFile(join(fresh.profile.workspace, "check.sh"), "exit 0\n");
				await expect(fresh.verify()).rejects.toThrow("changed reviewed source");
			} finally {
				await fresh.cleanup();
			}
		} finally {
			await h.fixture.cleanup();
		}
	});
});

describe.skipIf(process.platform !== "darwin")("independent gate in real macOS sandbox", () => {
	test("reads project data but denies writing it even under a shared temporary root", async () => {
		const h = await setup(
			'cat "$WARREN_PROJECT_INPUTS/sample"\nif echo poison > "$WARREN_PROJECT_INPUTS/sample"; then exit 8; fi\n',
		);
		try {
			const inputs = join(h.fixture.root, "inputs");
			await mkdir(inputs);
			await writeFile(join(inputs, "sample"), "source-data\n");
			h.profile.projectInputsPath = inputs;
			h.profile.readOnlyMounts = [inputs];
			await h.run();
			expect(await Bun.file(join(inputs, "sample")).text()).toBe("source-data\n");
			const event = h.record.events.find((event) => event.kind === "quality_gate.completed");
			expect(event?.payload).toMatchObject({ exitCode: 0 });
		} finally {
			await h.fixture.cleanup();
		}
	});

	test("binds and connects Unix sockets through a short private temporary path", async () => {
		const h = await setup("bun socket.mjs\n", {
			"socket.mjs": `import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
const path = join(process.env.PWTEST_SOCKETS_DIR ?? process.env.TMPDIR, "playwright-private-session.sock");
if (Buffer.byteLength(path) > 103) throw new Error("Unix socket path exceeds macOS limit");
const server = createServer(socket => socket.end("SOCKET_OK"));
server.listen(path);
await once(server, "listening");
const client = createConnection(path);
const [message] = await once(client, "data");
if (message.toString() !== "SOCKET_OK") throw new Error("Wrong IPC response");
client.destroy();
server.close();
await once(server, "close");
console.log(process.env.PWTEST_SOCKETS_DIR);
`,
		});
		try {
			await h.run();
			const payload = h.record.events.at(-1)?.payload as { stdout: string; exitCode: number };
			expect(payload.exitCode).toBe(0);
			expect(payload.stdout.trim()).toMatch(/^\/private\/tmp\/wg-[^/]+\/s$/);
			expect(existsSync(dirname(payload.stdout.trim()))).toBe(false);
		} finally {
			await h.fixture.cleanup();
		}
	});
	test("uses fresh HOME and dependencies with read-only Git metadata", async () => {
		const h = await setup(
			`set -eu\ntest ! -e "$HOME/auth.json"\ntest -z "\${WARREN_API_TOKEN:-}"\ntest ! -e node_modules/poison\ntest ! -r ../../reviewer-home/auth.json\ntest ! -r ../../reviewer/node_modules/poison\nif git config test.marker escaped; then exit 23; fi\necho FRESH_GATE_OK\n`,
		);
		try {
			await mkdir(join(h.profile.workspace, "node_modules"));
			await writeFile(join(h.profile.workspace, "node_modules/poison"), "poison");
			await h.run();
			expect(h.record.events.at(-1)).toMatchObject({
				kind: "quality_gate.completed",
				payload: { exitCode: 0, stdout: "FRESH_GATE_OK\n" },
			});
			expect(
				(await readdir(h.fixture.root)).filter((name) => name.startsWith(".quality-gate-")),
			).toEqual([]);
		} finally {
			await h.fixture.cleanup();
		}
	});
	test("bootstraps local dependencies in the disposable checkout", async () => {
		const h = await setup(
			"set -eu\ntest ! -d node_modules\nbun install --ignore-scripts --no-save\nbun -e 'if (require(\"local-check\") !== 7) process.exit(1)'\necho BOOTSTRAP_OK\n",
			{
				"package.json": JSON.stringify({
					name: "gate-acceptance",
					private: true,
					dependencies: { "local-check": "file:./local-check" },
				}),
				"local-check/package.json": JSON.stringify({
					name: "local-check",
					version: "1.0.0",
					main: "index.js",
				}),
				"local-check/index.js": "module.exports = 7;\n",
			},
		);
		try {
			await h.run();
			expect(h.record.events.at(-1)).toMatchObject({
				kind: "quality_gate.completed",
				payload: { exitCode: 0 },
			});
			expect(
				(h.record.events.at(-1)?.payload as { stdout?: string } | undefined)?.stdout,
			).toContain("BOOTSTRAP_OK");
			expect(existsSync(join(h.profile.workspace, "node_modules"))).toBe(false);
		} finally {
			await h.fixture.cleanup();
		}
	});

	test("ignores malicious reviewer metadata and assume-unchanged worktree content", async () => {
		const h = await setup("echo real-check-failed\nexit 9\n");
		try {
			const marker = join(h.fixture.root, "host-command-executed");
			await mkdir(join(h.profile.workspace, ".git"));
			await writeFile(
				join(h.profile.workspace, ".git/config"),
				`[core]\nfsmonitor = touch ${marker}\n`,
			);
			await h.git("update-index", "--assume-unchanged", "check.sh");
			await writeFile(join(h.fixture.path, "check.sh"), "exit 0\n");
			await writeFile(join(h.profile.workspace, "check.sh"), "exit 0\n");
			await expect(h.run()).rejects.toThrow("exit 9");
			expect(existsSync(marker)).toBe(false);
			expect(h.record.events.at(-1)).toMatchObject({
				kind: "quality_gate.completed",
				payload: { exitCode: 9 },
			});
		} finally {
			await h.fixture.cleanup();
		}
	});
	test("refuses a successful script that changes the reviewed source", async () => {
		const h = await setup("printf changed > check.sh\nexit 0\n");
		try {
			await expect(h.run()).rejects.toThrow("changed reviewed source");
			expect(h.record.events.some((event) => event.kind === "quality_gate.completed")).toBe(false);
		} finally {
			await h.fixture.cleanup();
		}
	});
});
