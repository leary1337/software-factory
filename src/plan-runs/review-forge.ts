import type { ReviewMergeResult } from "../core/review-merge.ts";
import type { Repos } from "../db/repos/index.ts";
import type { Forge, PullRequestRef, RepoRef } from "../forge/contract.ts";
import { resolvePollTarget } from "../runs/pr-merge.ts";
import { decideAutoMerge } from "../runs/reap/auto-merge-policy.ts";
import { type AutoMergeSnapshot, readAutoMergeSnapshot } from "../runs/reap/auto-merge-snapshot.ts";
import type { ReapExec } from "../runs/reap/types.ts";
import { DefaultsConfigSchema } from "../warren-config/schema.ts";
import { loadTaskApproval } from "./approved-dispatch.ts";
import type { CoordinatorMergeFn } from "./coordinator.ts";
import { planPermissionDecision } from "./permissions.ts";
import { blockedMerge, mergeForgeProblem, policyMergeProblem } from "./review-merge-problems.ts";
import type { publishReviewedHead } from "./review-publish.ts";
import { mergeWithWarren, waitingMerge } from "./review-warren-merge.ts";

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
	repos: Pick<Repos, "projects"> & Partial<Pick<Repos, "planApprovals">>;
	exec: ReapExec;
	readSnapshot?: typeof readAutoMergeSnapshot;
	publishHead?: typeof publishReviewedHead;
}

export function createReviewedMerge(deps: ReviewSnapshotDeps): CoordinatorMergeFn {
	return async (prUrl, branch, reviewedCommit, projectId, approvalContext) => {
		const target = resolvePollTarget(deps.forge, prUrl);
		if (target.kind === "unparseable")
			return blockedMerge(
				"unsupported_forge",
				"The pull request URL cannot be resolved.",
				"Open the pull request and merge manually.",
			);
		const pr = await deps.forge.getPullRequest(target.ref, target.pr);
		if (!pr.ok) return mergeForgeProblem(pr.error);
		if (pr.value.headCommit !== reviewedCommit) return staleHead();
		if (pr.value.lifecycle === "merged") return { kind: "merged" };
		if (pr.value.lifecycle !== "open")
			return blockedMerge(
				"not_open",
				"The pull request is closed without merging.",
				"Inspect the closed pull request before resuming the plan.",
			);
		const snapshot = await loadSnapshot(deps, {
			prUrl,
			branch,
			projectId,
			baseBranch: pr.value.baseBranch,
			ref: target.ref,
			pr: target.pr,
		});
		if (!snapshot)
			return blockedMerge(
				"snapshot_unavailable",
				"The project has no local checkout for merge verification.",
				"Restore the project checkout and retry verification.",
			);
		const grant = await approvedMergePaths(deps, approvalContext, snapshot);
		await freezeMergeSettings(deps, approvalContext, snapshot);
		if (grant.kind === "blocked") return grant.result;
		return mergeSnapshot(
			deps,
			deps.forge,
			target.ref,
			target.pr,
			snapshot,
			reviewedCommit,
			branch,
			pr.value.baseBranch,
			projectId,
			grant.paths,
		);
	};
}

async function mergeSnapshot(
	deps: ReviewSnapshotDeps,
	forge: Forge,
	ref: RepoRef,
	pr: PullRequestRef,
	snapshot: AutoMergeSnapshot,
	reviewedCommit: string,
	branch: string,
	baseBranch: string,
	projectId: string,
	approvedPlanPaths?: readonly string[],
): Promise<ReviewMergeResult> {
	if (!snapshot.headCommit)
		return blockedMerge(
			"diff_unreadable",
			"The current remote merge snapshot could not be read.",
			"Check repository access and retry verification before merging.",
		);
	if (snapshot.headCommit !== reviewedCommit) return staleHead();
	if (snapshot.config?.verification === "warren" && snapshot.baseCommit === reviewedCommit)
		return waitingMerge(
			"merge_confirmation_pending",
			"The reviewed head is already published; waiting for PR confirmation.",
		);
	const policy = decideAutoMerge({
		...snapshot,
		independentlyReviewed: true,
		approvedPlanPaths,
		forgeCanArm: snapshot.config?.verification === "warren" || forge.capabilities.autoMergeArm,
		ciFixerRun: false,
	});
	if (policy.decision !== "arm") return policyMergeProblem(policy);
	if (snapshot.config?.verification === "warren") {
		const project = await deps.repos.projects.require(projectId);
		if (!project.localPath)
			return blockedMerge(
				"snapshot_unavailable",
				"Project checkout unavailable.",
				"Restore the checkout.",
			);
		return mergeWithWarren({
			forge,
			ref,
			pr,
			snapshot,
			project: { gitUrl: project.gitUrl, localPath: project.localPath },
			exec: deps.exec,
			branch,
			baseBranch,
			head: reviewedCommit,
			publishHead: deps.publishHead,
		});
	}
	const safety = await verifyBase(forge, ref, baseBranch, snapshot);
	if (safety) return safety;
	const merged = await forge.mergePullRequest(ref, pr, {
		expectedHead: reviewedCommit,
		method: policy.method,
	});
	if (!merged.ok) return mergeForgeProblem(merged.error);
	await forge.deleteBranch(ref, branch);
	return { kind: "merged" };
}

function staleHead(): ReviewMergeResult {
	return blockedMerge(
		"stale_head",
		"The pull request head changed after review.",
		"Wait for a fresh review and independent gate on the new commit.",
	);
}

async function verifyBase(
	forge: Forge,
	ref: RepoRef,
	branch: string,
	snapshot: AutoMergeSnapshot,
): Promise<ReviewMergeResult | null> {
	if (
		!snapshot.baseCommit ||
		!/^[a-f0-9]{40}$/.test(snapshot.baseCommit) ||
		snapshot.baseIsAncestor !== true
	)
		return blockedMerge(
			"stale_base",
			"The reviewed commit does not contain the current target branch.",
			"Update the pull request branch from its target, then rerun review and the independent gate.",
		);
	if (!forge.readMergeProtection) return protectionRequired();
	const protection = await forge.readMergeProtection(ref, branch);
	if (!protection.ok)
		return protection.error.kind === "not_found" || protection.error.kind === "forbidden"
			? protectionRequired()
			: mergeForgeProblem(protection.error);
	if (!protection.value.requiresUpToDate) return protectionRequired();
	if (protection.value.baseCommit !== snapshot.baseCommit)
		return blockedMerge(
			"stale_base",
			"The target branch advanced during merge verification.",
			"Update the pull request branch, then rerun review and the independent gate.",
		);
	return null;
}

function protectionRequired(): ReviewMergeResult {
	return blockedMerge(
		"protection_required",
		"The forge cannot prove an enforced up-to-date merge rule.",
		"Configure strict required branch checks with administrator bypass disabled and grant protection read access, or merge manually.",
	);
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
	return (deps.readSnapshot ?? readAutoMergeSnapshot)(
		{
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
		},
		"reviewed-plan",
	);
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

async function approvedMergePaths(
	deps: ReviewSnapshotDeps,
	context: { planRunId: string; seq: number } | undefined,
	snapshot: AutoMergeSnapshot,
): Promise<{ kind: "allowed"; paths?: string[] } | { kind: "blocked"; result: ReviewMergeResult }> {
	if (!context) return { kind: "allowed" };
	const approval = await deps.repos.planApprovals?.forRun(context.planRunId);
	if (!approval) return { kind: "allowed" };
	if (snapshot.changedPaths.kind !== "changed" || snapshot.diffText === undefined)
		return {
			kind: "blocked",
			result: blockedMerge(
				"permission_diff_unavailable",
				"Cannot verify special changes against the approved plan.",
				"Restore diff access and retry verification.",
			),
		};
	const decision = planPermissionDecision(
		approval.snapshot,
		context.seq,
		snapshot.changedPaths.paths,
		snapshot.diffText,
	);
	if (decision.blocked.length)
		return {
			kind: "blocked",
			result: blockedMerge(
				"plan_permission_required",
				`The approved plan does not permit: ${decision.blocked.map((item) => `${item.kind}: ${item.path}`).join(", ")}`,
				"Approve a specific remaining-plan revision before retrying review.",
			),
		};
	return { kind: "allowed", paths: decision.allowed };
}

async function freezeMergeSettings(
	deps: ReviewSnapshotDeps,
	context: { planRunId: string; seq: number } | undefined,
	snapshot: AutoMergeSnapshot,
) {
	if (!context) return;
	const frozen = await loadTaskApproval(deps.repos, context.planRunId, context.seq);
	if (frozen) snapshot.config = DefaultsConfigSchema.parse(frozen.snapshot.settings).pr?.autoMerge;
}
