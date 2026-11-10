/**
 * The factory's review step: between a child's PR opening and the human merge,
 * run `reviewer`, and on a CHANGES verdict run `rework` on the same branch,
 * up to {@link MAX_REWORKS} times. The steps are recorded as events on the
 * child's run, so the state survives a server restart with no new columns.
 */

import { parseVerdict, passedReviewCommit } from "./review-result.ts";

export { parseVerdict } from "./review-result.ts";

import type { RunRow } from "../db/schema.ts";
import type { CoordinatorRepos } from "./coordinator.ts";
import { PlanRunSpawnDeferredError } from "./errors.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";
import { currentReviewEvents, finishReview, pendingReviewDelivery } from "./review-delivery.ts";

export const MAX_REWORKS = 2;
export const REVIEWED_AGENT = "implementer";

export type ReviewStepKind = "review" | "rework";
export type ReviewOutcome = "passed" | "changes_left" | "broken";

export interface ReviewStepRecord {
	readonly step: ReviewStepKind;
	readonly state: "running" | "succeeded" | "failed";
	readonly resultText: string | null;
	readonly reviewedCommit?: string;
}

export type ReviewDecision =
	| { readonly kind: "spawn"; readonly step: "review" }
	| { readonly kind: "spawn"; readonly step: "rework"; readonly findings: string }
	| { readonly kind: "wait" }
	| { readonly kind: "finished"; readonly outcome: ReviewOutcome; readonly report: string };

export function decideReviewStep(steps: readonly ReviewStepRecord[]): ReviewDecision {
	const last = steps.at(-1);
	if (last === undefined) return { kind: "spawn", step: "review" };
	if (last.state === "running") return { kind: "wait" };
	if (last.state === "failed") {
		return { kind: "finished", outcome: "broken", report: `The ${last.step} run failed.` };
	}
	if (last.step === "rework") return { kind: "spawn", step: "review" };

	const report = last.resultText ?? "";
	const verdict = parseVerdict(report);
	if (verdict === null) {
		return { kind: "finished", outcome: "broken", report: "The review gave no verdict." };
	}
	if (verdict === "PASS") {
		const commit = passedReviewCommit(report);
		if (commit === null || (last.reviewedCommit !== undefined && commit !== last.reviewedCommit)) {
			return {
				kind: "finished",
				outcome: "broken",
				report: "The review did not confirm the pinned commit and complete quality gate.",
			};
		}
		return { kind: "finished", outcome: "passed", report };
	}
	if (steps.filter((s) => s.step === "rework").length >= MAX_REWORKS) {
		return { kind: "finished", outcome: "changes_left", report };
	}
	return { kind: "spawn", step: "rework", findings: report };
}

/** Where a child with an open PR actually is, for the plan view. */
export type ReviewStage = "reviewing" | "reworking" | "ready_to_merge" | "needs_attention";

export function reviewStageOf(steps: readonly ReviewStepRecord[]): ReviewStage {
	const decision = decideReviewStep(steps);
	if (decision.kind === "spawn") return decision.step === "review" ? "reviewing" : "reworking";
	if (decision.kind === "wait") return steps.at(-1)?.step === "rework" ? "reworking" : "reviewing";
	return decision.outcome === "passed" ? "ready_to_merge" : "needs_attention";
}

/** The review stage of a child's run, or null for plans without the review step. */
export async function loadReviewStage(
	repos: ReviewRepos,
	agentName: string,
	runId: string,
): Promise<ReviewStage | null> {
	if (agentName !== REVIEWED_AGENT) return null;
	const events = await repos.events.listByRun(runId);
	const finished = currentReviewEvents(events).find(
		(event) => event.kind === "plan_run.review_finished",
	);
	if (finished && (finished.payloadJson as { outcome?: string }).outcome !== "passed")
		return "needs_attention";
	return reviewStageOf(await loadSteps(repos, runId));
}

export type ReviewRepos = Pick<CoordinatorRepos, "events" | "runs">;

export async function loadSteps(
	repos: ReviewRepos,
	runId: string,
): Promise<readonly ReviewStepRecord[]> {
	const events = await repos.events.listByRun(runId);
	const records: ReviewStepRecord[] = [];
	for (const event of events) {
		if (event.kind !== "plan_run.review_step") continue;
		const payload = event.payloadJson as {
			step: ReviewStepKind;
			stepRunId: string;
			reviewedCommit?: string;
		};
		const stepRun = await repos.runs.require(payload.stepRunId);
		// A step that leaves the branch untouched ends as no_changes; for a reviewer that is the job done.
		const finishedCleanly = stepRun.state === "succeeded" || stepRun.failureReason === "no_changes";
		records.push({
			step: payload.step,
			reviewedCommit: payload.reviewedCommit ?? stepRun.baseCommit ?? "",
			state: finishedCleanly ? "succeeded" : stepRun.endedAt === null ? "running" : "failed",
			resultText: finishedCleanly ? await readResultText(repos, stepRun.id) : null,
		});
	}
	return records;
}

async function readResultText(repos: ReviewRepos, runId: string): Promise<string | null> {
	const tail = await repos.events.listTail(runId, 40);
	for (const event of [...tail].reverse()) {
		const payload = event.payloadJson as { type?: string; result?: unknown };
		if (payload.type === "result" && typeof payload.result === "string") return payload.result;
	}
	return null;
}

async function describeTicket(input: HandleInFlightInput): Promise<string> {
	const issue = await input.getIssue(input.planRun.projectId, input.child.seedId);
	return `## Ticket ${issue.id}: ${issue.title ?? ""}\n\n${issue.description ?? ""}`;
}

/**
 * Advance the review step for an open PR. Returns a decision while the review
 * is still working, or null once it is finished and the PR waits for the human.
 */
export async function advanceReview(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
): Promise<HandleInFlightDecision | null> {
	if (input.planRun.agentName !== REVIEWED_AGENT) return null;
	const events = currentReviewEvents(await input.repos.events.listByRun(run.id));
	const steps = await loadSteps(input.repos, run.id);
	const last = steps.at(-1);
	// GitHub may briefly report the pre-push head. Every verdict applies only to
	// its pin, including CHANGES and a previously delivered terminal report.
	if (
		last?.step === "review" &&
		last.state !== "running" &&
		last.reviewedCommit &&
		input.getReviewHead
	) {
		const head = await input.getReviewHead(prUrl);
		if (head === null) return { kind: "result", result: { kind: "waiting_for_run" } };
		if (head !== last.reviewedCommit)
			return spawnReviewStep(input, run, prUrl, { kind: "spawn", step: "review" });
	}
	if (events.some((event) => event.kind === "plan_run.review_finished")) return null;

	const pending = await pendingReviewDelivery(input, run.id);
	const decision: ReviewDecision = pending
		? { kind: "finished", ...pending }
		: decideReviewStep(steps);

	if (decision.kind === "wait") {
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}
	if (decision.kind === "finished") {
		return await finishReview(input, run, prUrl, decision.outcome, decision.report);
	}
	return spawnReviewStep(input, run, prUrl, decision);
}

async function spawnReviewStep(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	decision: Extract<ReviewDecision, { kind: "spawn" }>,
): Promise<HandleInFlightDecision | null> {
	if (run.branch === null) {
		return await finishReview(input, run, prUrl, "broken", "The run has no branch to review.");
	}

	const reviewedCommit =
		decision.step === "review" ? await input.getReviewHead?.(prUrl) : undefined;
	if (decision.step === "review" && !reviewedCommit) {
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}
	const ticket = await describeTicket(input);
	const prompt =
		decision.step === "review"
			? `Review commit ${reviewedCommit} of ${prUrl}. The fixed point of the diff is ${run.baseCommit ?? "the merge-base with the default branch"}.\n\n${ticket}`
			: `Fix these findings from the automated review of ${prUrl}.\n\n${decision.findings}\n\n${ticket}`;

	try {
		const spawned = await input.spawn({
			planRun: input.planRun,
			child: input.child,
			prompt,
			agentName: decision.step === "review" ? "reviewer" : "rework",
			existingBranch: run.branch,
			...(reviewedCommit ? { baseCommit: reviewedCommit } : {}),
			onRunCreated: async (stepRunId) =>
				input.emit(run.id, "plan_run.review_step", {
					planRunId: input.planRun.id,
					seq: input.child.seq,
					step: decision.step,
					stepRunId,
					...(reviewedCommit ? { reviewedCommit } : {}),
				}),
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
			`The ${decision.step} run did not start.`,
		);
	}
}

/** Resume an interrupted delivery before advancing past an already merged PR. */
export async function resumeReviewDelivery(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
): Promise<HandleInFlightDecision | null> {
	if (input.planRun.agentName !== REVIEWED_AGENT) return null;
	const events = currentReviewEvents(await input.repos.events.listByRun(run.id));
	if (events.some((event) => event.kind === "plan_run.review_finished")) return null;
	const pending = await pendingReviewDelivery(input, run.id);
	return pending ? finishReview(input, run, prUrl, pending.outcome, pending.report) : null;
}
