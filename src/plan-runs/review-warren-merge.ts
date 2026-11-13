import type { ReviewMergeResult } from "../core/review-merge.ts";
import type { Forge, PullRequestRef, RepoRef } from "../forge/contract.ts";
import type { AutoMergeSnapshot } from "../runs/reap/auto-merge-snapshot.ts";
import type { ReapExec } from "../runs/reap/types.ts";
import { blockedMerge, mergeForgeProblem } from "./review-merge-problems.ts";
import { publishReviewedHead } from "./review-publish.ts";

export const MERGE_WAIT_REASONS = new Set([
	"checks_pending",
	"branch_update_pending",
	"merge_confirmation_pending",
	"stale_head",
	"stale_base",
]);
export function waitingMerge(reason: string, detail: string): ReviewMergeResult {
	return { kind: "retry", reason, detail, nextAction: "Warren will recheck automatically." };
}

/** Called only after the coordinator's PASS + independently verified gate.
 * Policy and required check names come from the fetched base, never the PR. */
interface WarrenMergeInput {
	forge: Forge;
	ref: RepoRef;
	pr: PullRequestRef;
	snapshot: AutoMergeSnapshot;
	project: { gitUrl: string; localPath: string };
	exec: ReapExec;
	branch: string;
	baseBranch: string;
	head: string;
	publishHead?: typeof publishReviewedHead;
}

export async function mergeWithWarren(input: WarrenMergeInput): Promise<ReviewMergeResult> {
	const { forge, ref, pr, snapshot, head } = input;
	const config = snapshot.config;
	if (
		config?.verification !== "warren" ||
		config.method !== "merge" ||
		!config.requiredChecks?.length ||
		!snapshot.baseCommit ||
		!/^[a-f0-9]{40}$/.test(snapshot.baseCommit)
	)
		return blockedMerge(
			"invalid_policy",
			"Warren merge policy or base is incomplete.",
			"Inspect the base branch policy.",
		);
	if (snapshot.baseIsAncestor !== true) return refreshBranch(input);
	const checkFailure = await verifyChecks(input, config.requiredChecks);
	if (checkFailure) return checkFailure;
	// Re-read PR identity after CI: a new head/base must not inherit this PASS.
	const current = await forge.getPullRequest(ref, pr);
	if (!current.ok) return mergeForgeProblem(current.error);
	if (current.value.headCommit !== head || current.value.baseBranch !== input.baseBranch)
		return waitingMerge("stale_head", "The PR changed; waiting for a fresh review.");
	if (current.value.lifecycle === "merged") return { kind: "merged" };
	if (current.value.draft !== false)
		return blockedMerge(
			"draft_pr",
			"The PR is a draft or its readiness is unknown.",
			"Mark the reviewed PR ready for review.",
		);
	if (current.value.lifecycle !== "open")
		return blockedMerge("not_open", "The PR is closed without merging.", "Inspect the closed PR.");
	const result = await (input.publishHead ?? publishReviewedHead)({
		...input,
		base: snapshot.baseCommit,
	});
	if (result === "stale_head" || result === "stale_base")
		return waitingMerge(
			result,
			"A branch changed before publication; rechecking the reviewed snapshot.",
		);
	if (result === "failed")
		return {
			kind: "retry",
			reason: "publish_failed",
			detail: "The reviewed commit could not be published.",
			nextAction: "Warren will retry with fresh branch verification.",
		};
	// Never infer PR completion from a push acknowledgement. The next poll
	// confirms GitHub marked this exact PR merged before advancing the plan.
	return waitingMerge(
		"merge_confirmation_pending",
		"Reviewed history published; waiting for PR merge confirmation.",
	);
}

async function refreshBranch(input: WarrenMergeInput): Promise<ReviewMergeResult> {
	const { forge, ref, pr, snapshot, head } = input;
	if (snapshot.baseIsAncestor !== false || !forge.updatePullRequestBranch)
		return blockedMerge(
			"stale_base",
			"The reviewed tree does not contain the current base.",
			"Update the PR branch and rerun review.",
		);
	const updated = await forge.updatePullRequestBranch(ref, pr, head);
	if (!updated.ok) return mergeForgeProblem(updated.error);
	return waitingMerge(
		"branch_update_pending",
		"Updating the PR branch before a fresh review and independent gate.",
	);
}
async function verifyChecks(
	input: WarrenMergeInput,
	requiredChecks: readonly string[],
): Promise<ReviewMergeResult | null> {
	const { forge, ref, head } = input;
	if (!forge.readMergeChecks)
		return blockedMerge(
			"checks_unavailable",
			"The forge cannot verify complete CI results.",
			"Configure a supported check reader.",
		);
	const checks = await forge.readMergeChecks(ref, head);
	if (!checks.ok) return mergeForgeProblem(checks.error);
	if (checks.value.conclusion === "failing")
		return blockedMerge(
			"checks_failed",
			"CI reported a failed check on the reviewed commit.",
			"Fix the failed checks before retrying review.",
		);
	const required = requiredChecks.every((name) =>
		checks.value.runs.some(
			(run) => run.name === name && run.status === "completed" && run.conclusion === "success",
		),
	);
	if (checks.value.conclusion !== "passing" || !required)
		return waitingMerge(
			"checks_pending",
			"Waiting for all CI results and the configured required checks.",
		);

	return null;
}
