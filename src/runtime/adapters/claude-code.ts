/**
 * The `claude-code` adapter (warren-c80e phase 1; harness hooks
 * source-lifted from burrow's `src/runtime/claude-code.ts` in
 * warren-7933, plan pl-3007).
 *
 * Claude Code's `--input-format stream-json` reads one user/system JSON
 * envelope per line from stdin and emits matching `--output-format
 * stream-json` lines on stdout. The adapter renders the prompt + any
 * pending steering messages as a single multi-line stdin blob, then the
 * parser in `./parsers/jsonl-claude.ts` turns each output line into
 * structured events.
 *
 * `prepareWorkspace` writes a minimal `.claude/settings.local.json` so
 * the agent has a stable settings file even when the project ships none,
 * plants a private `.sandbox-tmp/` for the spawn's `TMPDIR` (burrow-8452 —
 * the host UID-keyed `/tmp/claude-${uid}/` root races every other
 * claude-code on the machine during startup cleanup). It never writes
 * credentials: the worktree is what the agent commits and warren pushes, so
 * the host OAuth blob goes into the run's separate HOME instead
 * (`../local/drive-prepare.ts`, `./claude-credentials.ts`).
 *
 * claude-code `--print` relies on stdin EOF to flush its final output, so
 * this adapter deliberately declares NO `shouldCloseStdinOnEvent` and NO
 * `encodeSteeringMessage` — pending messages flow through
 * `pendingMessages` at the next spawn (burrow SPEC §13.2).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeToolkitConfig } from "../../toolkit/catalog.ts";
import { resolveToolkitBundle } from "../../toolkit/versions.ts";
import { pstackPluginDir } from "../local/skill-pack.ts";
import { mulchClaudeHooks, readMulchArm } from "./mulch-arm.ts";
import { parseJsonlClaude } from "./parsers/jsonl-claude.ts";
import type {
	AdapterPrepareContext,
	AdapterRuntimeEvent,
	AdapterSpawnContext,
	AgentRuntimeAdapter,
	SpawnCommand,
	SteeringMessage,
} from "./types.ts";

const CLAUDE_BIN = "claude";

export const CLAUDE_CODE_SETTINGS_PATH = ".claude/settings.local.json";

/**
 * Per-run TMPDIR root. claude-code's Bash tool stores command output
 * under `${TMPDIR-/tmp}/claude-${uid}/...` and runs a startup cleanup
 * sweep across the entire UID-keyed root — that races every other
 * claude-code on the host (the user's terminal session, sibling runs) and
 * surfaces as `<bash output unavailable: ... could not be read (EPERM)>`.
 * Pinning TMPDIR inside the workspace gives each spawned claude a private
 * sweep boundary (burrow-8452).
 */
export const CLAUDE_CODE_SANDBOX_TMPDIR = ".sandbox-tmp";

const DEFAULT_SETTINGS: Record<string, unknown> = {
	permissions: {},
	hooks: {},
};

export const claudeCodeAdapter: AgentRuntimeAdapter = {
	runtimeId: "claude-code",
	/**
	 * The harness drops `.claude/settings.local.json` into the workspace at
	 * runtime. This is the prefix `HARNESS_STATE_PREFIXES` carried before the
	 * seam existed, moved verbatim (warren-f6f2). `.claude.json` is a sibling
	 * file (not a child of `.claude/`) that claude-code also writes at runtime —
	 * `'.claude.json'.startsWith('.claude/')` is false, so it needs its own
	 * entry (warren-8dc8).
	 */
	harnessStatePrefixes: [".claude/", ".claude.json"],
	/**
	 * Exact files only. `.claude/` is tracked in plenty of target repos
	 * (this one keeps five files there), so excluding the prefix would eat
	 * real work; `.claude/settings.local.json` and `.claude.json` have not
	 * been observed in a pull request yet. Add the exact file the day one
	 * does (warren-194a).
	 *
	 * `.claude/.credentials.json` holds an OAuth token. The adapter once
	 * forwarded it into the worktree, where every reap reported it dirty and
	 * a broad `git add -A` would have pushed it. Warren no longer writes it
	 * there; the exclude keeps a stray copy (an agent's own `/login`, a
	 * leftover workspace) out of the branch.
	 */
	commitExcludes: [".claude/.credentials.json"],
	/**
	 * Empty by evidence, not by omission. The provider-error net (warren-edc3)
	 * was written against pi's turn lifecycle, and warren has never observed
	 * a claude-code envelope carrying `stopReason`. The generic classifier
	 * still reads the union of every adapter's types, so this declaration
	 * does not narrow what a claude-code run is checked against today; see
	 * `providerErrorEnvelopeTypes` in `./index.ts`.
	 */
	terminalErrorEnvelopeTypes: [],

	buildSpawnCommand(ctx: AdapterSpawnContext): SpawnCommand {
		return {
			argv: [
				CLAUDE_BIN,
				"--print",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				// The sandbox is the enforcement boundary; an in-app prompt would
				// deadlock a non-interactive spawn.
				"--dangerously-skip-permissions",
				"--mcp-config",
				claudeToolkitConfig(
					ctx.workspacePath,
					ctx.frontmatter?.toolkitVersion
						? resolveToolkitBundle(ctx.frontmatter.toolkitVersion)
						: undefined,
					ctx.homePath,
				),
				...(ctx.homePath !== undefined ? ["--plugin-dir", pstackPluginDir(ctx.homePath)] : []),
				...(ctx.frontmatter?.model !== undefined ? ["--model", ctx.frontmatter.model] : []),
			],
			env: { TMPDIR: claudeCodeBurrowTmpdir(ctx.workspacePath) },
			stdin: encodeClaudeStdin(ctx.prompt, ctx.pendingMessages),
		};
	},

	parseEvents(line: string): AdapterRuntimeEvent[] {
		return parseJsonlClaude(line);
	},

	encodeInboxMessage(messages: readonly SteeringMessage[]): { stdin: string } {
		return { stdin: messages.map(claudeUserTurnFromMessage).join("\n") };
	},

	async prepareWorkspace(ctx: AdapterPrepareContext): Promise<void> {
		const claudeDir = join(ctx.workspacePath, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		// Mulch arm "on" installs mulch's hooks (`./mulch-arm.ts`); absent/"off" keeps `hooks: {}`.
		const settings =
			readMulchArm(ctx.frontmatter) === "on"
				? { ...DEFAULT_SETTINGS, hooks: mulchClaudeHooks() }
				: DEFAULT_SETTINGS;
		writeFileSync(
			join(ctx.workspacePath, CLAUDE_CODE_SETTINGS_PATH),
			`${JSON.stringify(settings, null, 2)}\n`,
			{ encoding: "utf8", flag: "w" },
		);
		ensureBurrowTmpdir(ctx.workspacePath);
	},
};

/**
 * Resolve the in-sandbox absolute path of the per-run TMPDIR. The runtime
 * always shares a platform with the host that runs it, so
 * `process.platform` is the right proxy for sandbox layout: bwrap remaps
 * the workspace to `/workspace`, sandbox-exec leaves it at the host path.
 * Exposed with a `plat` override for unit tests.
 */
export function claudeCodeBurrowTmpdir(
	workspacePath: string,
	plat: NodeJS.Platform = process.platform,
): string {
	const home = plat === "linux" ? "/workspace" : workspacePath;
	return join(home, CLAUDE_CODE_SANDBOX_TMPDIR);
}

/**
 * Materialize the per-run TMPDIR on the host and drop a `*` .gitignore so
 * tool output never trips `git status` inside a project worktree.
 */
function ensureBurrowTmpdir(workspacePath: string): void {
	const dir = join(workspacePath, CLAUDE_CODE_SANDBOX_TMPDIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "w" });
}

/**
 * Encode the run's prompt followed by any pending steering messages as a
 * single stdin blob (one JSON envelope per line). Exported for unit tests.
 */
export function encodeClaudeStdin(prompt: string, messages: readonly SteeringMessage[]): string {
	const lines: string[] = [];
	if (prompt.length > 0) lines.push(claudeUserTurn(prompt));
	for (const m of messages) lines.push(claudeUserTurnFromMessage(m));
	return lines.join("\n");
}

function claudeUserTurn(text: string): string {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function claudeUserTurnFromMessage(message: SteeringMessage): string {
	const tag = `[STEERING] (priority: ${message.priority}) `;
	return claudeUserTurn(`${tag}${message.body}`);
}
