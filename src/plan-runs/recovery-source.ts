import type { Repos } from "../db/repos/index.ts";
import { defaultSpawn, type SpawnFn } from "../projects/clone.ts";

/** Import saved Git work locally. This never pushes or mutates a forge branch. */
export async function recoveryBaseCommit(input: {
	repos: Repos;
	recoveryOf?: string;
	fallback?: string;
	projectId: string;
	localPath: string;
	role: string;
	spawn?: SpawnFn;
}): Promise<string | undefined> {
	if (!input.recoveryOf || input.role === "reviewer") return input.fallback;
	const original = await input.repos.runs.require(input.recoveryOf);
	if (original.projectId !== input.projectId)
		throw new Error("Recovery source belongs to another project");
	if (!original.salvagePath) return input.fallback;
	const spawn = input.spawn ?? defaultSpawn;
	const git = async (args: string[]) => {
		const result = await spawn(["git", ...args], { cwd: input.localPath, timeoutMs: 30_000 });
		if (result.exitCode !== 0)
			throw new Error(
				"Saved Git work could not be verified; recovery stopped without discarding the archive",
			);
		return result.stdout.trim();
	};
	await git(["bundle", "verify", original.salvagePath]);
	const ref = `refs/warren/recovery/${original.id}`;
	await git(["fetch", "--no-tags", original.salvagePath, `refs/heads/warren-recovery:${ref}`]);
	const commit = await git(["rev-parse", `${ref}^{commit}`]);
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Saved recovery commit is invalid");
	return commit;
}
