import { isAbsolute } from "node:path";
import { resolveSandboxEnv } from "../../sandbox/env.ts";
import { spawnGuardedProcess } from "../../sandbox/guarded-process.ts";
import {
	makeCloseStdin,
	makeWriteStdin,
	resolveCwd,
	writeStringStdin,
} from "../../sandbox/process-io.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import { CODEX_BIN } from "../adapters/codex.ts";

/** Host process execution keeps lifecycle ownership, without applying OS isolation. */
export async function runHostProcess(
	profile: SandboxProfile,
	command: SpawnCommand,
	options: {
		codexBin?: string;
		hostEnv?: Record<string, string | undefined>;
		lifecyclePath?: string;
	} = {},
): Promise<SpawnResult> {
	if (process.platform !== "darwin") throw new Error("Host process execution requires macOS");
	const argv = [...command.argv];
	if (options.codexBin && argv[0] === CODEX_BIN) argv[0] = options.codexBin;
	const env = resolveSandboxEnv(profile, command, {
		homePath: profile.home,
		workspacePath: profile.workspace,
		hostEnv: options.hostEnv ?? process.env,
	});
	env.TMPDIR ??= profile.home;
	const guarded = await spawnGuardedProcess({
		argv,
		cwd: resolveCwd(profile.workspace, command.cwd),
		env,
		stdin: command.stdin !== undefined ? "pipe" : "ignore",
		lifecyclePath: options.lifecyclePath ?? `${profile.home}.lifecycle.json`,
	});
	const proc = guarded.proc;
	try {
		await writeStringStdin(proc, command.stdin, command.holdStdin ?? false);
	} catch (error) {
		guarded.cancel();
		await proc.exited;
		throw error;
	}
	return {
		pid: guarded.pid,
		stdout: proc.stdout as ReadableStream<Uint8Array>,
		stderr: proc.stderr as ReadableStream<Uint8Array>,
		exited: proc.exited,
		cancel: guarded.cancel,
		closeStdin: makeCloseStdin(proc),
		writeStdin: makeWriteStdin(proc),
	};
}

export function resolveCodexExecutable(
	env: Readonly<Record<string, string | undefined>>,
): string | undefined {
	const path = env.WARREN_CODEX_BIN?.trim();
	if (path && !isAbsolute(path)) throw new Error("WARREN_CODEX_BIN must be an absolute path");
	return path || undefined;
}
