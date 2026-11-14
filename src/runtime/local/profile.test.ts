import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makePrivateGitFixture } from "../../sandbox/git-scope.test-helpers.ts";
import { resolvePrivateGitScope } from "../../sandbox/git-scope.ts";
import type { MaterializedWorkspace } from "../../workspace/materialize.ts";
import type { RunSpec } from "../contract.ts";
import {
	buildLocalSandboxProfile,
	resolveEnvPassthrough,
	resolveToolchainPaths,
} from "./profile.ts";

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_p1",
		originUrl: "https://github.com/o/r.git",
		branch: "warren/run_p1",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do it",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: {},
		...overrides,
	};
}

function fakeWorkspace(path = "/tmp/ws"): MaterializedWorkspace {
	return {
		workspacePath: path,
		source: { kind: "clone", branch: "warren/run_p1" },
		identity: null,
	};
}

describe("resolveEnvPassthrough", () => {
	test("returns the claude-code allowlist", () => {
		expect(resolveEnvPassthrough("claude-code", undefined)).toContain("ANTHROPIC_API_KEY");
		expect(resolveEnvPassthrough("claude-code", undefined)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	test("forwards no credentials to retired Pi", () => {
		expect(resolveEnvPassthrough("pi", { provider: "openai" })).toEqual([]);
	});

	test("returns no passthrough for an unknown runtime", () => {
		expect(resolveEnvPassthrough("codex", undefined)).toEqual([]);
	});
});

describe("resolveToolchainPaths", () => {
	// The macOS git preflight records a /usr/bin/git substitution on
	// process.env (warren-1219). Another suite's real preflight can leave it
	// set, which would leak /usr/bin into these injected-`which` results.
	const savedSandboxGit = process.env.WARREN_GIT_BIN;
	beforeEach(() => {
		delete process.env.WARREN_GIT_BIN;
	});
	afterEach(() => {
		if (savedSandboxGit === undefined) delete process.env.WARREN_GIT_BIN;
		else process.env.WARREN_GIT_BIN = savedSandboxGit;
	});

	// Empty third arg suppresses the host bun-install auto-grant so these
	// tests stay hermetic regardless of whether ~/.bun exists on the runner.
	test("adds the resolved bin dir for agent + common binaries", () => {
		const which = (name: string): string | null =>
			name === "claude" ? "/home/dev/.local/bin/claude" : null;
		const dirs = resolveToolchainPaths("claude-code", which, "");
		expect(dirs).toContain("/home/dev/.local/bin");
	});

	test("keeps system-mounted bin dirs for the PATH contribution", () => {
		const which = (name: string): string | null => (name === "git" ? "/usr/bin/git" : null);
		const dirs = resolveToolchainPaths("pi", which, "");
		expect(dirs).toContain("/usr/bin");
	});

	test("skips binaries that do not resolve and dedupes dirs", () => {
		const dirs = resolveToolchainPaths("claude-code", () => null, "");
		expect(dirs).toEqual([]);
	});

	test("adds the host bun install root and global modules when present (warren-bea7)", () => {
		const root = mkdtempSync(join(tmpdir(), "warren-bun-install-"));
		try {
			const globalModules = join(root, "install/global/node_modules");
			mkdirSync(globalModules, { recursive: true });
			const dirs = resolveToolchainPaths("claude-code", () => null, root);
			expect(dirs).toContain(root);
			expect(dirs).toContain(globalModules);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("skips a missing host bun install root", () => {
		const dirs = resolveToolchainPaths(
			"claude-code",
			() => null,
			"/no/such/bun-install-root-warren-bea7",
		);
		expect(dirs).toEqual([]);
	});
});

describe("buildLocalSandboxProfile", () => {
	test("applies the factory runtime deadline when no project or run limit is set", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec({ runtimeId: "codex" }),
			env: {},
			workspace: fakeWorkspace(),
			homePath: "/tmp/home",
		});
		expect(profile.timeoutMs).toBe(20 * 60_000);
	});

	test("uses an open host network without an OS allowlist", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec({ network: "restricted" }),
			env: {},
			workspace: fakeWorkspace(),
			homePath: "/tmp/home",
		});
		expect(profile.allowedDomains).toEqual([]);
		expect(profile.network).toBe("open");
	});

	test("binds the workspace and the separate writable HOME (warren-c865)", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec(),
			env: { WARREN_QUALITY_GATE: "verify" },
			workspace: fakeWorkspace(),
			homePath: "/tmp/home/run_p1",
		});
		expect(profile.workspace).toBe("/tmp/ws");
		expect(profile.home).toBe("/tmp/home/run_p1");
		expect(profile.home).not.toBe(profile.workspace);
		expect(profile.setEnv.WARREN_QUALITY_GATE).toBe("verify");
		expect(profile.envPassthrough).toContain("ANTHROPIC_API_KEY");
	});

	test("points the sandbox at the workspace gitconfig only when an identity was written", async () => {
		const bare = await buildLocalSandboxProfile({
			spec: makeSpec(),
			env: {},
			workspace: fakeWorkspace(),
			homePath: "/tmp/home",
		});
		expect(bare.gitconfigFile).toBeUndefined();
		const withIdentity = await buildLocalSandboxProfile({
			spec: makeSpec(),
			env: {},
			workspace: { ...fakeWorkspace(), identity: { name: "Bot", email: "bot@example.com" } },
			homePath: "/tmp/home",
		});
		expect(withIdentity.gitconfigFile).toBe(".gitconfig.burrow");
	});

	test("mounts the validated private git scope (warren-3c1e)", async () => {
		const fx = await makePrivateGitFixture();
		try {
			const workspace: MaterializedWorkspace = {
				workspacePath: fx.ws,
				source: fx.source,
				identity: null,
			};
			const gitScope = resolvePrivateGitScope({
				workspacePath: fx.ws,
				gitDir: fx.gitDir,
				hostGitDir: fx.hostGitDir,
				configSha256: fx.source.gitConfigSha256 ?? "",
			});
			const profile = await buildLocalSandboxProfile({
				spec: makeSpec(),
				env: {},
				workspace,
				homePath: "/tmp/home",
				gitScope,
			});
			expect(profile.workspaceGit).toEqual({
				gitDir: fx.gitDir,
				protectedPaths: [
					join(fx.gitDir, "config"),
					join(fx.gitDir, "objects", "info", "alternates"),
				],
				hostGitDir: fx.hostGitDir,
				sharedObjects: join(fx.hostGitDir, "objects"),
				deniedRoots: [dirname(fx.gitDir), join(dirname(dirname(fx.gitDir)), "gitdirs-sealed")],
			});
		} finally {
			rmSync(fx.root, { recursive: true, force: true });
		}
	});

	test("omits git mounts when no scope is passed", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec(),
			env: {},
			workspace: fakeWorkspace(),
			homePath: "/tmp/home",
		});
		expect(profile.workspaceGit).toBeUndefined();
	});

	test("spec timeoutMs wins over burrow.toml timeout_minutes", async () => {
		const root = mkdtempSync(join(tmpdir(), "warren-profile-"));
		try {
			writeFileSync(join(root, "burrow.toml"), "[sandbox]\ntimeout_minutes = 5\n");
			const profile = await buildLocalSandboxProfile({
				spec: makeSpec({ hostClonePathHint: root, timeoutMs: 60_000 }),
				env: {},
				workspace: fakeWorkspace(),
				homePath: "/tmp/home",
			});
			expect(profile.timeoutMs).toBe(60_000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("omits retired Pi provider credentials", async () => {
		const profile = await buildLocalSandboxProfile({
			spec: makeSpec({ runtimeId: "pi" }),
			env: {},
			workspace: fakeWorkspace(),
			homePath: "/tmp/home",
			frontmatter: { provider: "groq" },
		});
		expect(profile.envPassthrough).toEqual([]);
	});
});

describe("resolveToolchainPaths (WARREN_GIT_BIN override, warren-1219)", () => {
	const ENV = "WARREN_GIT_BIN";

	afterEach(() => {
		delete process.env[ENV];
	});

	test("prefers the preflight substitution over PATH resolution for git", () => {
		process.env[ENV] = "/usr/bin/git";
		const which = (name: string): string | null =>
			name === "git" ? "/nix/store/abc-git/bin/git" : null;
		const dirs = resolveToolchainPaths("pi", which, "");
		expect(dirs).toContain("/usr/bin");
		expect(dirs).not.toContain("/nix/store/abc-git/bin");
	});

	test("still uses PATH resolution for git when no override is set", () => {
		const which = (name: string): string | null =>
			name === "git" ? "/nix/store/abc-git/bin/git" : null;
		const dirs = resolveToolchainPaths("pi", which, "");
		expect(dirs).toContain("/nix/store/abc-git/bin");
	});
});
