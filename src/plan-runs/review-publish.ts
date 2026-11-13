import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitRepoContextScrubEnv } from "../bot-identity.ts";
import type { Forge } from "../forge/contract.ts";
import { mintGitCredential } from "../forge/credentials.ts";
import type { ReapExec } from "../runs/reap/types.ts";
import { authenticatedCloneUrl } from "../workspace/git/clone-url.ts";

export interface PublishReviewedHeadInput {
	readonly forge: Forge;
	readonly exec: ReapExec;
	readonly project: { gitUrl: string; localPath: string };
	readonly branch: string;
	readonly baseBranch: string;
	readonly head: string;
	readonly base: string;
}
export type PublishReviewedHeadResult = "published" | "stale_head" | "stale_base" | "failed";

/** Fast-forward exactly the reviewed history with an explicit base compare-and-swap.
 * No repository hooks, worktree, agent config or remote tracking refs are trusted. */
export async function publishReviewedHead(
	input: PublishReviewedHeadInput,
): Promise<PublishReviewedHeadResult> {
	const cwd = await mkdtemp(join(dirname(input.project.localPath), ".warren-reviewed-merge-"));
	const git = (args: readonly string[]) =>
		input.exec.run("git", args, {
			cwd,
			timeoutMs: 30_000,
			env: gitRepoContextScrubEnv(),
		});
	const remote = async () =>
		authenticatedCloneUrl(
			input.project.gitUrl,
			await mintGitCredential(input.forge, input.project.gitUrl),
		);
	try {
		if (![input.head, input.base].every((sha) => /^[a-f0-9]{40}$/.test(sha))) return "failed";
		if (input.branch === input.baseBranch) return "failed";
		await git(["init", "--bare", "--template="]);
		for (const branch of [input.branch, input.baseBranch])
			await git(["check-ref-format", `refs/heads/${branch}`]);
		await git([
			"fetch",
			"--no-tags",
			"--",
			await remote(),
			`refs/heads/${input.branch}:refs/warren/head`,
			`refs/heads/${input.baseBranch}:refs/warren/base`,
		]);
		const head = (await git(["rev-parse", "refs/warren/head^{commit}"])).stdout.trim();
		const base = (await git(["rev-parse", "refs/warren/base^{commit}"])).stdout.trim();
		if (head !== input.head) return "stale_head";
		if (base !== input.base) return "stale_base";
		if ((await git(["merge-base", base, head])).stdout.trim() !== base) return "stale_base";
		// The ancestry check makes this a fast-forward. The explicit lease is an
		// atomic expected-old-value check, never permission to rewrite history.
		try {
			await git([
				"-c",
				"core.hooksPath=/dev/null",
				"push",
				"--porcelain",
				`--force-with-lease=refs/heads/${input.baseBranch}:${base}`,
				"--",
				await remote(),
				`${head}:refs/heads/${input.baseBranch}`,
			]);
		} catch {
			// A transport timeout may follow a successful push. Read back rather
			// than repeat a mutation with a new expected base.
			const value = (
				await git(["ls-remote", "--refs", "--", await remote(), `refs/heads/${input.baseBranch}`])
			).stdout.split(/\s/)[0];
			if (value === head) return "published";
			return value !== base ? "stale_base" : "failed";
		}
		return "published";
	} catch {
		// Git errors may include credential-bearing URLs; never expose them.
		return "failed";
	} finally {
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}
