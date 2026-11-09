/**
 * Agent git-identity env helpers for the dispatch path (warren-4e36,
 * warren-e7b7). Extracted from `dispatch.ts` to keep that file under the
 * per-file size budget (warren-4553).
 */

import type { EnvLike } from "./callback-env.ts";

/** Both halves or nothing — mirrors the supervisor's rule (warren-4e36). */
function readGitIdentity(serverEnv: EnvLike): { name: string; email: string } | undefined {
	const name = serverEnv.WARREN_GIT_AUTHOR_NAME?.trim();
	const email = serverEnv.WARREN_GIT_AUTHOR_EMAIL?.trim();
	if (name === undefined || name === "" || email === undefined || email === "") {
		return undefined;
	}
	return { name, email };
}

/**
 * Forward the operator's agent-commit identity (`WARREN_GIT_AUTHOR_NAME` /
 * `WARREN_GIT_AUTHOR_EMAIL`, see `.env.example`) into the sandbox as the four
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars git reads ahead of any config.
 *
 * This is the only path that carries them into a Local sandbox: `warren up`
 * runs no supervisor, so nothing else exports them (gh #1298). `warren up`
 * copies its stored `~/.warren/env` into `process.env` for this read. On the
 * K8s path there is NO supervisor and the run pod has no gitconfig at all — without this every
 * agent `git commit` dies with "Author identity unknown" exit 128 (hit live on
 * GKE, warren-4e36). Mirrors the supervisor's rule: both halves or nothing.
 */
export function injectGitIdentityEnv(env: Record<string, string>, serverEnv: EnvLike): void {
	const identity = readGitIdentity(serverEnv);
	if (identity === undefined) return;
	env.GIT_AUTHOR_NAME = identity.name;
	env.GIT_AUTHOR_EMAIL = identity.email;
	env.GIT_COMMITTER_NAME = identity.name;
	env.GIT_COMMITTER_EMAIL = identity.email;
}
