/** Resolve the local process environment, tool paths, private Git scope and deadline. */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AcceptedRuntimeId } from "../../core/wire.ts";
import type { PrivateGitScope } from "../../sandbox/git-scope.ts";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { WORKSPACE_GITCONFIG_FILENAME } from "../../workspace/git/identity.ts";
import type { MaterializedWorkspace } from "../../workspace/materialize.ts";
import { allAdapters } from "../adapters/index.ts";
import type { RunSpec } from "../contract.ts";
import { privateGitDenyRoots } from "./paths.ts";
import { resolveProjectInputs, withProjectInputs } from "./project-inputs.ts";

/* -------------------------------------------------------------------------- */
/* Env passthrough (warren-owned allowlist; warren-fb8d formalizes)            */
/* -------------------------------------------------------------------------- */

/** claude-code's host-env allowlist — burrow's `CLAUDE_CODE_ENV_PASSTHROUGH`. */
export const CLAUDE_CODE_ENV_PASSTHROUGH: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
];

/** Resolve host credentials only for the executable harness that needs them. */
export function resolveEnvPassthrough(
	runtimeId: AcceptedRuntimeId,
	_frontmatter: Record<string, unknown> | undefined,
): string[] {
	return runtimeId === "claude-code" ? [...CLAUDE_CODE_ENV_PASSTHROUGH] : [];
}

/* -------------------------------------------------------------------------- */
/* Toolchain paths                                                             */
/* -------------------------------------------------------------------------- */

/** Prefixes bwrap already mounts read-only (src/sandbox/bwrap.ts SYSTEM_RO_MOUNTS). */
const SYSTEM_RO_PREFIXES = ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt"];

/** Binaries probed per runtime — the agent CLI plus the tools every run needs. */
const AGENT_BINARIES: Readonly<Record<string, readonly string[]>> = {
	"claude-code": ["claude"],
	codex: ["codex"],
};
const COMMON_BINARIES: readonly string[] = ["git", "bun", "node"];

function isUnderSystemMounts(path: string): boolean {
	return SYSTEM_RO_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Resolve one probed binary. `git` honors `WARREN_GIT_BIN` (warren-1219):
 * the sandbox git preflight sets it when the PATH-resolved git fails inside
 * the sandbox but /usr/bin/git passes, so profile composition prefers the
 * binary that actually executes there. An operator may also pin it by hand.
 */
function resolveBinaryPath(name: string, which: (name: string) => string | null): string | null {
	if (name === "git") {
		const override = process.env.WARREN_GIT_BIN;
		if (typeof override === "string" && override !== "") return override;
	}
	return which(name);
}

/**
 * Resolve the host paths the sandbox must mount + PATH-prepend so the agent's
 * bare-name argv resolves inside bwrap. For each probed binary: the bin dir
 * (the name's home) always contributes a PATH entry; when the resolved binary
 * (symlink target) escapes bwrap's system RO mounts, its directory is added
 * too so the target exists inside the sandbox. Missing binaries are skipped —
 * the spawn itself surfaces a clear ENOENT.
 *
 * The `git` entry honors `WARREN_GIT_BIN` (warren-1219): the sandbox
 * git preflight sets it when the PATH-resolved git fails inside the sandbox
 * but /usr/bin/git passes, so profile composition prefers the binary that
 * actually executes there.
 */
export function resolveToolchainPaths(
	runtimeId: AcceptedRuntimeId,
	which: (name: string) => string | null = (name) => Bun.which(name),
	/**
	 * Host bun install root. Defaults to `$BUN_INSTALL` or `~/.bun`. Injected
	 * for tests; production uses the real host path so the sandbox can read
	 * bun-shebang CLI sources under `install/global/node_modules` (burrow-aa46)
	 * and so macOS seatbelt grants the same root (warren-bea7).
	 */
	hostBunInstall: string = defaultHostBunInstall(),
): string[] {
	const names = [...(AGENT_BINARIES[runtimeId] ?? []), ...COMMON_BINARIES];
	const dirs: string[] = [];
	const seen = new Set<string>();
	const add = (dir: string): void => {
		if (dir === "" || dir === "." || seen.has(dir)) return;
		seen.add(dir);
		dirs.push(dir);
	};
	for (const name of names) {
		const found = resolveBinaryPath(name, which);
		if (found === null) continue;
		// The bin dir carries the NAME (a symlink or the binary itself). It always
		// lands on the profile: bwrap's nested --ro-bind over an already-mounted
		// system path is a no-op collision, and env.ts prepends it to PATH (the
		// /usr/bin:/bin fallback alone never finds /usr/local/bin installs).
		add(dirname(found));
		try {
			const target = realpathSync(found);
			if (!isUnderSystemMounts(target)) add(dirname(target));
		} catch {
			// unresolvable symlink — the name dir above is the best we can do
		}
	}
	// Bun global CLIs (sd, ml, …) are bun-shebang stubs under `<BUN_INSTALL>/bin`
	// that import their .ts sources from `install/global/node_modules`. Mount the
	// modules root whenever the install tree exists so those stubs resolve inside
	// the sandbox (burrow-aa46). Always mount the install root itself when present
	// so bun's getpwuid-based ~/.bun lookup (not $HOME) succeeds on macOS
	// (warren-bea7) and on Linux bwrap where host home is otherwise invisible.
	if (hostBunInstall !== "" && existsSync(hostBunInstall)) {
		add(hostBunInstall);
		const globalModules = join(hostBunInstall, "install/global/node_modules");
		if (existsSync(globalModules)) add(globalModules);
	}
	return dirs;
}

function defaultHostBunInstall(): string {
	const fromEnv = process.env.BUN_INSTALL;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".bun");
}

export interface BuildProfileInput {
	readonly spec: RunSpec;
	/** The composed sandbox env (domain env + provider plumbing). */
	readonly env: Record<string, string>;
	readonly workspace: MaterializedWorkspace;
	/** The run's private writable HOME host dir (already created). */
	readonly homePath: string;
	readonly frontmatter?: Record<string, unknown>;
	/** Test seam for `Bun.which`. */
	readonly which?: (name: string) => string | null;
	/** The validated private git scope the engine pinned (warren-3c1e). */
	readonly gitScope?: PrivateGitScope | null;
}

/**
 * warren-3c1e: the run's private git dir is writable (minus its config and
 * alternates file) and the host clone's object store is read-only.
 */
function workspaceGitFields(
	scope: PrivateGitScope | null | undefined,
): Pick<SandboxProfile, "workspaceGit"> {
	if (scope === null || scope === undefined) return {};
	return {
		workspaceGit: {
			gitDir: scope.gitDir,
			protectedPaths: [...scope.protectedPaths],
			hostGitDir: scope.hostGitDir,
			sharedObjects: scope.sharedObjects,
			deniedRoots: privateGitDenyRoots(scope.gitDir),
		},
	};
}

/**
 * Compose the `SandboxProfile` for one local run. `resources` precedence:
 * per-run `spec.resources` > project `burrow.toml` (burrow's historical
 * source) — `projectResources` is K8s-only (pod shapes), so it is ignored here.
 */
export async function buildLocalSandboxProfile(input: BuildProfileInput): Promise<SandboxProfile> {
	const { spec, workspace } = input;
	const projectInputsPath = await resolveProjectInputs(spec.projectId);

	const profile: SandboxProfile = {
		workspace: workspace.workspacePath,
		home: input.homePath,
		readOnlyMounts: [],
		network: "open",
		allowedDomains: [],
		envPassthrough: resolveEnvPassthrough(spec.runtimeId, input.frontmatter),
		setEnv: input.env,
		toolchainPaths: resolveToolchainPaths(spec.runtimeId, input.which),
		...(workspace.identity !== null ? { gitconfigFile: WORKSPACE_GITCONFIG_FILENAME } : {}),
		...workspaceGitFields(input.gitScope),
		// warren-fabb: per-project agent image override — consumed only by the
		// container spawn seams (docker); the bwrap profile builder ignores it.
		...(spec.agentImage !== undefined ? { agentImage: spec.agentImage } : {}),
		timeoutMs:
			spec.timeoutMs ??
			allAdapters().find((adapter) => adapter.runtimeId === spec.runtimeId)?.defaultTimeoutMs,
	};
	return withProjectInputs(profile, projectInputsPath);
}
