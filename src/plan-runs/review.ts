import { decideReviewStep } from "./review-decision.ts";
import { spawnReviewStep } from "./review-dispatch.ts";

export { decideReviewStep } from "./review-decision.ts";

import type { ReviewEvidence } from "../core/review-findings.ts";
import { parseReviewEvidence } from "../runtime/review-artifacts.ts";
import { loadReviewBudget, reviewBudgetReason } from "./review-progress.ts";

export { MAX_REWORKS } from "./review-progress.ts";

import { includeUiReview } from "./ui-review.ts";
/**
 * The factory's review step: between a child's PR opening and the human merge,
 * run `reviewer`, and on a CHANGES verdict run `rework` on the same branch,
 * up to {@link MAX_REWORKS} times. The steps are recorded as events on the
 * child's run, so the state survives a server restart with no new columns.
 */

import { hasQualityGateWitness, reportWithVerifiedGate } from "../core/quality-gate.ts";
import type { ReviewStage, ReviewStepKind } from "../core/wire.ts";

export type { ReviewStage, ReviewStepKind } from "../core/wire.ts";

import { parseVerdict } from "./review-result.ts";

export { parseVerdict } from "./review-result.ts";

import type { RunRow } from "../db/schema.ts";
import type { CoordinatorRepos } from "./coordinator.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";
import { currentReviewEvents, finishReview, pendingReviewDelivery } from "./review-delivery.ts";

export const REVIEWED_AGENT = "implementer";

export type ReviewOutcome = "passed" | "changes_left" | "broken";

export interface ReviewStepRecord {
	readonly step: ReviewStepKind;
	readonly state: "running" | "succeeded" | "failed";
	readonly resultText: string | null;
	readonly reviewedCommit?: string;
	readonly gateVerified?: boolean;
	readonly evidenceRequired?: boolean;
	readonly evidence?: ReviewEvidence;
	readonly costUsd?: number | null;
	readonly activeMs?: number | null;
}

export type ReviewDecision =
	| {
			readonly kind: "spawn";
			readonly step: "review" | "ui_review";
			readonly reviewedCommit?: string;
	  }
	| { readonly kind: "spawn"; readonly step: "rework"; readonly findings: string }
	| { readonly kind: "wait" }
	| { readonly kind: "finished"; readonly outcome: ReviewOutcome; readonly report: string };

/** Where a child with an open PR actually is, for the plan view. */

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
			evidenceRequired?: boolean;
		};
		records.push(await loadStep(repos, payload));
	}
	return records;
}

async function loadStep(
	repos: ReviewRepos,
	payload: {
		step: ReviewStepKind;
		stepRunId: string;
		reviewedCommit?: string;
		evidenceRequired?: boolean;
	},
): Promise<ReviewStepRecord> {
	const stepRun = await repos.runs.require(payload.stepRunId);
	// A step that leaves the branch untouched ends as no_changes; for a reviewer that is the job done.
	const finishedCleanly = stepRun.state === "succeeded" || stepRun.failureReason === "no_changes";
	const commit = payload.reviewedCommit ?? stepRun.baseCommit ?? "";
	const stepEvents = await repos.events.listByRun(stepRun.id);
	const gateVerified = hasQualityGateWitness(stepEvents, commit);
	const rawEvidence = [...stepEvents]
		.reverse()
		.find((event) => event.stream === "system" && event.kind === "review_check.evidence");
	const evidence = parseReviewEvidence(rawEvidence?.payloadJson);
	const activeMs =
		stepRun.startedAt && stepRun.endedAt
			? Date.parse(stepRun.endedAt) - Date.parse(stepRun.startedAt)
			: null;
	const report = finishedCleanly ? await readResultText(repos, stepRun.id) : null;
	return {
		gateVerified,
		evidenceRequired: payload.evidenceRequired,
		...(evidence ? { evidence } : {}),
		costUsd: stepRun.costUsd,
		activeMs:
			stepRun.startedAt === undefined ? undefined : Number.isFinite(activeMs) ? activeMs : null,
		step: payload.step,
		reviewedCommit: payload.reviewedCommit ?? stepRun.baseCommit ?? "",
		state: finishedCleanly ? "succeeded" : stepRun.endedAt === null ? "running" : "failed",
		resultText: report && gateVerified ? reportWithVerifiedGate(report, commit) : report,
	};
}

export async function readResultText(repos: ReviewRepos, runId: string): Promise<string | null> {
	const tail = await repos.events.listTail(runId, 40);
	// Independent gates and reproductions run after the model's result and can fill the tail.
	return resultFromEvents(tail) ?? resultFromEvents(await repos.events.listByRun(runId));
}

function resultFromEvents(events: readonly { payloadJson: unknown }[]): string | null {
	for (const event of [...events].reverse()) {
		const payload = event.payloadJson as { type?: string; result?: unknown };
		if (payload.type === "result" && typeof payload.result === "string") return payload.result;
	}
	return null;
}

async function reviewHeadChanged(
	input: HandleInFlightInput,
	last: ReviewStepRecord | undefined,
	prUrl: string,
): Promise<boolean | null> {
	if (
		!last ||
		last.step === "rework" ||
		last.state === "running" ||
		!last.reviewedCommit ||
		!input.getReviewHead
	)
		return false;
	const head = await input.getReviewHead(prUrl);
	return head === null ? null : head !== last.reviewedCommit;
}

function needsPortableReview(
	last: ReviewStepRecord | undefined,
	steps: readonly ReviewStepRecord[],
): boolean {
	return (
		!!last &&
		!last.evidenceRequired &&
		last.state === "succeeded" &&
		parseVerdict(last.resultText ?? "") === "CHANGES" &&
		reviewBudgetReason(steps, loadReviewBudget()) === null
	);
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
	const stale = await reviewHeadChanged(input, last, prUrl);
	if (stale === null) return { kind: "result", result: { kind: "waiting_for_run" } };
	if (stale) return spawnReviewStep(input, run, prUrl, { kind: "spawn", step: "review" });
	if (events.some((event) => event.kind === "plan_run.review_finished")) {
		// Upgrade an exhausted legacy loop once: obtain portable proofs before another rework.
		if (needsPortableReview(last, steps))
			return spawnReviewStep(input, run, prUrl, { kind: "spawn", step: "review" });
		return null;
	}

	const pending = await pendingReviewDelivery(input, run.id);
	const baseDecision: ReviewDecision = pending
		? pending.outcome === "passed" && last?.gateVerified !== true
			? {
					kind: "finished",
					outcome: "broken",
					report: "The runtime quality-gate witness is missing.",
				}
			: { kind: "finished", ...pending }
		: decideReviewStep(steps, loadReviewBudget());

	const decision = await includeUiReview(input, run.branch, prUrl, last, baseDecision);

	if (decision.kind === "wait") {
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}
	if (decision.kind === "finished") {
		return await finishReview(input, run, prUrl, decision.outcome, decision.report);
	}
	return spawnReviewStep(input, run, prUrl, decision);
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
	if (pending?.outcome === "passed") {
		const last = (await loadSteps(input.repos, run.id)).at(-1);
		if (last?.gateVerified !== true)
			return finishReview(
				input,
				run,
				prUrl,
				"broken",
				"The runtime quality-gate witness is missing.",
			);
	}
	return pending ? finishReview(input, run, prUrl, pending.outcome, pending.report) : null;
}
