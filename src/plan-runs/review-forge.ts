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
interface ReviewSnapshotDeps {
	forge: Forge;
	repos: Pick<Repos, "projects">;
	exec: ReapExec;
	readSnapshot?: typeof readAutoMergeSnapshot;
}

export function createReviewedMerge(deps: ReviewSnapshotDeps): CoordinatorMergeFn {
	return async (prUrl, branch, reviewedCommit, projectId) => {
		const target = resolvePollTarget(deps.forge, prUrl);
		if (target.kind === "unparseable") return false;
		const pr = await deps.forge.getPullRequest(target.ref, target.pr);
		if (!pr.ok || pr.value.headCommit !== reviewedCommit) return false;
		if (pr.value.lifecycle === "merged") return true;
		if (pr.value.lifecycle !== "open") return false;
		const snapshot = await loadSnapshot(deps, {
			prUrl,
			branch,
			projectId,
			baseBranch: pr.value.baseBranch,
			ref: target.ref,
			pr: target.pr,
		});
		if (!snapshot) return false;
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

async function loadSnapshot(
	deps: ReviewSnapshotDeps,
	input: {
		prUrl: string;
		branch: string;
		projectId: string;
		baseBranch: string;
		ref: RepoRef;
		pr: PullRequestRef;
	},
): Promise<AutoMergeSnapshot | null> {
	const project = await deps.repos.projects.require(input.projectId);
	if (!project.localPath) return null;
	return (deps.readSnapshot ?? readAutoMergeSnapshot)({
		projectAutoMerge: undefined,
		run: { id: "review" },
		project,
		prUrl: input.prUrl,
		prNumber: input.pr.number,
		repoRef: input.ref,
		prRef: input.pr,
		branch: input.branch,
		baseBranch: input.baseBranch,
		workspacePath: null,
		forge: deps.forge,
		exec: deps.exec,
		emit: async () => {},
	});
}

/** Re-read the diff from remote commits; a stale or unreadable head never skips UI review. */
export function createReviewChangedPathsReader(deps: ReviewSnapshotDeps) {
	return async (
		prUrl: string,
		branch: string,
		projectId: string,
		commit: string,
	): Promise<readonly string[] | null> => {
		const target = resolvePollTarget(deps.forge, prUrl);
		if (target.kind === "unparseable") return null;
		const pr = await deps.forge.getPullRequest(target.ref, target.pr);
		if (!pr.ok || pr.value.headCommit !== commit) return null;
		const snapshot = await loadSnapshot(deps, {
			prUrl,
			branch,
			projectId,
			baseBranch: pr.value.baseBranch,
			ref: target.ref,
			pr: target.pr,
		});
		if (!snapshot || snapshot.headCommit !== commit || snapshot.changedPaths.kind === "unreadable")
			return null;
		// Structural violations already require manual merge; do not park them forever
		// as a transient unreadable diff. The merge policy still refuses them.
		return snapshot.changedPaths.kind === "unsafe" ? [] : snapshot.changedPaths.paths;
	};
}
