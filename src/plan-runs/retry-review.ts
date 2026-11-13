import { StateTransitionError } from "../core/errors.ts";
import type { CoordinatorEmitFn, CoordinatorRepos } from "./coordinator.ts";
import { withPlanRunLock } from "./lock.ts";
import { decideReviewStep, loadReviewStage, loadSteps, REVIEWED_AGENT } from "./review.ts";
import { currentReviewEvents, hasPendingReviewRetry } from "./review-delivery.ts";

/** Re-drive review on the existing PR without resetting history, rework limits or budgets. */
export async function retryPlanRunReview(input: {
	readonly planRunId: string;
	readonly seq: number;
	readonly repos: CoordinatorRepos;
	readonly emit: CoordinatorEmitFn;
}): Promise<{ requested: boolean }> {
	return withPlanRunLock(input.planRunId, async () => {
		const plan = await input.repos.planRuns.require(input.planRunId);
		const children = await input.repos.planRuns.listChildren(plan.id);
		const child = children.find((entry) => entry.state !== "merged" && entry.state !== "skipped");
		if (
			plan.state !== "running" ||
			plan.agentName !== REVIEWED_AGENT ||
			child?.seq !== input.seq ||
			child.state !== "pr_open" ||
			!child.runId
		)
			throw new StateTransitionError(
				"Only the current open PR of a running implementer plan can retry review.",
			);
		const run = await input.repos.runs.require(child.runId);
		if (!run.branch || !run.prUrl)
			throw new StateTransitionError(
				"Review retry requires the existing task branch and pull request.",
			);
		const events = await input.repos.events.listByRun(run.id);
		if (recoveryPending(events)) return { requested: false };
		const steps = await loadSteps(input.repos, run.id);
		if (
			steps.some((step) => step.state === "running") ||
			(await loadReviewStage(input.repos, plan.agentName, run.id)) !== "needs_attention"
		)
			throw new StateTransitionError("Review is already active or does not require recovery.");
		const decision = decideReviewStep(steps);
		const verifiedPass =
			decision.kind === "finished" &&
			decision.outcome === "passed" &&
			steps.at(-1)?.gateVerified === true;
		// Delivery failures do not invalidate a pinned PASS. The coordinator still
		// rechecks the live head, policy and CI before attempting another merge.
		await input.emit(
			run.id,
			verifiedPass ? "plan_run.review_delivery_retry_requested" : "plan_run.review_retry_requested",
			{
				planRunId: plan.id,
				seq: child.seq,
			},
		);
		return { requested: true };
	});
}

function recoveryPending(events: Parameters<typeof currentReviewEvents>[0]): boolean {
	const current = currentReviewEvents(events);
	return (
		hasPendingReviewRetry(events) ||
		(current.some((event) => event.kind === "plan_run.review_delivery_retry_requested") &&
			!current.some((event) => event.kind === "plan_run.review_decided"))
	);
}
