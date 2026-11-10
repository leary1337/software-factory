import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { warrenCommitIdentityEnv } from "../../bot-identity.ts";
import { defaultExec } from "../../runs/reap/util.ts";
import type { LocalRunManifest } from "./manifest.ts";
import type { LocalStateRoots } from "./paths.ts";

/** Capture HEAD plus tracked and non-ignored work without changing the agent's index or branch. */
export async function archiveLocalWorkspace(
	roots: LocalStateRoots,
	manifest: LocalRunManifest,
	interrupted: boolean,
): Promise<string | undefined> {
	const cwd = manifest.workspacePath;
	const git = (args: string[], env?: Record<string, string | undefined>) =>
		defaultExec.run("git", args, { cwd, timeoutMs: 30_000, env });
	const dirty = (await git(["status", "--porcelain", "-z"])).stdout.length > 0;
	if (!interrupted && !dirty) return undefined;
	const directory = join(roots.dataDir, "recovery");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const target = join(directory, `${manifest.runId}.bundle`);
	const temporary = `${target}.${crypto.randomUUID()}.tmp`;
	const index = `${temporary}.index`;
	const env = { ...warrenCommitIdentityEnv(), GIT_INDEX_FILE: index };
	try {
		await git(["read-tree", "HEAD"], env);
		await git(["add", "-A", "--", "."], env);
		const tree = (await git(["write-tree"], env)).stdout.trim();
		const snapshot = (
			await git(["commit-tree", tree, "-p", "HEAD", "-m", "Warren interrupted workspace"], env)
		).stdout.trim();
		await git(["update-ref", "refs/heads/warren-recovery", snapshot]);
		await git(["bundle", "create", temporary, "refs/heads/warren-recovery"]);
		await chmod(temporary, 0o600);
		await git(["bundle", "verify", temporary]);
		await rename(temporary, target);
		return target;
	} finally {
		await rm(index, { force: true });
		await rm(temporary, { force: true });
	}
}
