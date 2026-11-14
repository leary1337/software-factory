import { formatError } from "../core/errors.ts";
import type { RunRow } from "../db/schema.ts";
import { instanceEnvSecretPattern, scrubSecrets } from "../observability/event-scrub.ts";
import { recordLearningEvidence } from "../runs/learning-evidence.ts";
import { approvedReviewBudget } from "./approved-dispatch.ts";
import { PlanRunSpawnDeferredError } from "./errors.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";
import { loadSteps, type ReviewDecision } from "./review.ts";
import { finishReview } from "./review-delivery.ts";
import { reviewBudgetReason } from "./review-progress.ts";
import { reviewHistoryPrompt } from "./review-prompt.ts";
import { UI_REVIEW_PROMPT } from "./ui-review.ts";

async function describeTicket(input: HandleInFlightInput): Promise<string> {
	const issue = await input.getIssue(input.planRun.projectId, input.child.seedId);
	return `## Ticket ${issue.id}: ${issue.title ?? ""}\n\n${issue.description ?? ""}`;
}

function describeReview(
	decision: Extract<ReviewDecision, { kind: "spawn" }>,
	reviewedCommit: string | null | undefined,
	prUrl: string,
	baseCommit: string | null,
	ticket: string,
): string {
	return decision.step !== "rework"
		? `${decision.step === "ui_review" ? `${UI_REVIEW_PROMPT}\n\n` : ""}Review commit ${reviewedCommit} of ${prUrl}. The fixed point of the diff is ${baseCommit ?? "the merge-base with the default branch"}.\n\n${ticket}`
		: `Fix these findings from the automated review of ${prUrl}.\n\n${decision.findings}\n\n${ticket}`;
}

export async function spawnReviewStep(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	decision: Extract<ReviewDecision, { kind: "spawn" }>,
): Promise<HandleInFlightDecision | null> {
	if (run.branch === null) {
		return await finishReview(input, run, prUrl, "broken", "The run has no branch to review.");
	}

	const reviewedCommit =
		decision.step !== "rework" ? await input.getReviewHead?.(prUrl) : undefined;
	if (decision.step !== "rework" && !reviewedCommit) {
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}
	if (decision.step === "ui_review" && decision.reviewedCommit !== reviewedCommit) {
		return spawnReviewStep(input, run, prUrl, { kind: "spawn", step: "review" });
	}
	const steps = await loadSteps(input.repos, run.id);
	const budget = await approvedReviewBudget(input.repos, input.planRun.id, input.child.seq);
	const blocked = reviewBudgetReason(steps, budget);
	if (blocked)
		return finishReview(input, run, prUrl, "changes_left", `Review loop stopped: ${blocked}.`);
	const history = reviewHistoryPrompt(steps, decision.step === "rework");
	const ticket = await describeTicket(input);
	const basePrompt = describeReview(decision, reviewedCommit, prUrl, run.baseCommit, ticket);
	const recovery = decision.recoveryReason
		? `\n\n## Automatic recovery\nThe previous attempt stopped: ${decision.recoveryReason}. Diagnose that failure before repeating the work. Keep the original proofs unchanged and verify actual behavior. Save completed code in commits before long checks. This retry shares the original task budget.`
		: "";
	const prompt = basePrompt + recovery + history.prompt;

	try {
		const spawned = await input.spawn({
			planRun: input.planRun,
			child: input.child,
			prompt,
			...(decision.recoveryReason
				? { attemptKind: "repair" as const, recoveryOf: steps.at(-1)?.runId }
				: {}),
			...(decision.step !== "rework" ? { reviewFindings: history.prior } : {}),
			agentName: decision.step === "rework" ? "rework" : "reviewer",
			existingBranch: run.branch,
			...(reviewedCommit ? { baseCommit: reviewedCommit } : {}),
			onRunCreated: async (stepRunId) => {
				await input.emit(run.id, "plan_run.review_step", {
					planRunId: input.planRun.id,
					seq: input.child.seq,
					step: decision.step,
					stepRunId,
					evidenceRequired: decision.step !== "rework",
					...(decision.recoveryReason ? { recoveryReason: decision.recoveryReason } : {}),
					...(reviewedCommit ? { reviewedCommit } : {}),
				});
				if (decision.step === "rework")
					await recordLearningEvidence(input.repos, input.emit, run.id, {
						sourceKey: `rework:${stepRunId}`,
						trigger: "rework",
						sourceRunId: stepRunId,
						projectId: input.planRun.projectId,
						planRunId: input.planRun.id,
						childSeq: input.child.seq,
						report: decision.findings,
					});
			},
		});
		return { kind: "result", result: { kind: "dispatched", childRunId: spawned.runId } };
	} catch (err) {
		if (err instanceof PlanRunSpawnDeferredError) {
			return { kind: "result", result: { kind: "noop", reason: err.code } };
		}
		return await finishReview(
			input,
			run,
			prUrl,
			"broken",
			`The ${decision.step} run did not start: ${scrubSecrets(formatError(err), instanceEnvSecretPattern())}. Fix the cause, then retry review on this task.`,
		);
	}
}
