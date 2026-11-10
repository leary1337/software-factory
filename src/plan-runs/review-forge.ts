import type { Repos } from "../db/repos/index.ts";
import type { Forge, PullRequestRef, RepoRef } from "../forge/contract.ts";
import { resolvePollTarget } from "../runs/pr-merge.ts";
import { decideAutoMerge } from "../runs/reap/auto-merge-policy.ts";
import { type AutoMergeSnapshot, readAutoMergeSnapshot } from "../runs/reap/auto-merge-snapshot.ts";
import type { ReapExec } from "../runs/reap/types.ts";
import type { CoordinatorMergeFn } from "./coordinator.ts";

export function createReviewHeadReader(forge: Forge) {
	return async (url: string): Promise<string | null> => {
		const target = resolvePollTarget(forge, url);
		if (target.kind === "unparseable") return null;
		const pr = await forge.getPullRequest(target.ref, target.pr);
		return pr.ok && /^[a-f0-9]{40}$/.test(pr.value.headCommit) ? pr.value.headCommit : null;
	};
}

/** The remote base policy and the exact reviewed head must both authorize merge. */
export function createReviewedMerge(deps: {
	forge: Forge;
	repos: Pick<Repos, "projects">;
	exec: ReapExec;
	readSnapshot?: typeof readAutoMergeSnapshot;
}): CoordinatorMergeFn {
	return async (prUrl, branch, reviewedCommit, projectId) => {
		const target = resolvePollTarget(deps.forge, prUrl);
		if (target.kind === "unparseable") return false;
		const pr = await deps.forge.getPullRequest(target.ref, target.pr);
		if (!pr.ok || pr.value.headCommit !== reviewedCommit) return false;
		if (pr.value.lifecycle === "merged") return true;
		if (pr.value.lifecycle !== "open") return false;
		const project = await deps.repos.projects.require(projectId);
		if (!project.localPath) return false;
		const snapshot = await (deps.readSnapshot ?? readAutoMergeSnapshot)({
			projectAutoMerge: undefined,
			run: { id: "review" },
			project,
			prUrl,
			prNumber: target.pr.number,
			repoRef: target.ref,
			prRef: target.pr,
			branch,
			baseBranch: pr.value.baseBranch,
			workspacePath: null,
			forge: deps.forge,
			exec: deps.exec,
			emit: async () => {},
		});
		return mergeSnapshot(deps.forge, target.ref, target.pr, snapshot, reviewedCommit, branch);
	};
}

async function mergeSnapshot(
	forge: Forge,
	ref: RepoRef,
	pr: PullRequestRef,
	snapshot: AutoMergeSnapshot,
	reviewedCommit: string,
	branch: string,
): Promise<boolean> {
	if (snapshot.headCommit !== reviewedCommit) return false;
	const policy = decideAutoMerge({
		...snapshot,
		forgeCanArm: forge.capabilities.autoMergeArm,
		ciFixerRun: false,
	});
	if (policy.decision !== "arm") return false;
	const merged = await forge.mergePullRequest(ref, pr, {
		expectedHead: reviewedCommit,
		method: policy.method,
	});
	if (!merged.ok) return false;
	await forge.deleteBranch(ref, branch);
	return true;
}
