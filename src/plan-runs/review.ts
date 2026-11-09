/**
 * The factory's review step: between a child's PR opening and the human merge,
 * run `reviewer`, and on a CHANGES verdict run `rework` on the same branch,
 * up to {@link MAX_REWORKS} times. The steps are recorded as events on the
 * child's run, so the state survives a server restart with no new columns.
 */

import type { RunRow } from "../db/schema.ts";
import type { CoordinatorRepos } from "./coordinator.ts";
import { PlanRunSpawnDeferredError } from "./errors.ts";
import type { HandleInFlightDecision, HandleInFlightInput } from "./in-flight.ts";

export const MAX_REWORKS = 2;
export const REVIEWED_AGENT = "implementer";

export type ReviewStepKind = "review" | "rework";
export type ReviewOutcome = "passed" | "changes_left" | "broken";

export interface ReviewStepRecord {
	readonly step: ReviewStepKind;
	readonly state: "running" | "succeeded" | "failed";
	readonly resultText: string | null;
}

export type ReviewDecision =
	| { readonly kind: "spawn"; readonly step: "review" }
	| { readonly kind: "spawn"; readonly step: "rework"; readonly findings: string }
	| { readonly kind: "wait" }
	| { readonly kind: "finished"; readonly outcome: ReviewOutcome; readonly report: string };

export function parseVerdict(text: string): "PASS" | "CHANGES" | null {
	const match = text.match(/^VERDICT:\s*(PASS|CHANGES)\b/m);
	return (match?.[1] as "PASS" | "CHANGES" | undefined) ?? null;
}

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
	if (verdict === "PASS") return { kind: "finished", outcome: "passed", report };
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
	return reviewStageOf(await loadSteps(repos, runId));
}

const OUTCOME_HEADINGS: Readonly<Record<ReviewOutcome, string>> = {
	passed: "Ревью фабрики: замечаний нет",
	changes_left: `Ревью фабрики: замечания остались после ${MAX_REWORKS} доработок`,
	broken: "Ревью фабрики не завершилось",
};

type ReviewRepos = Pick<CoordinatorRepos, "events" | "runs">;

async function loadSteps(repos: ReviewRepos, runId: string): Promise<readonly ReviewStepRecord[]> {
	const events = await repos.events.listByRun(runId);
	const records: ReviewStepRecord[] = [];
	for (const event of events) {
		if (event.kind !== "plan_run.review_step") continue;
		const payload = event.payloadJson as { step: ReviewStepKind; stepRunId: string };
		const stepRun = await repos.runs.require(payload.stepRunId);
		// A step that leaves the branch untouched ends as no_changes; for a reviewer that is the job done.
		const finishedCleanly = stepRun.state === "succeeded" || stepRun.failureReason === "no_changes";
		records.push({
			step: payload.step,
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

async function mergeIfPassed(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	outcome: ReviewOutcome,
): Promise<string> {
	if (outcome !== "passed" || input.mergePassedPr === undefined || run.branch === null) return "";
	const merged = await input.mergePassedPr(prUrl, run.branch);
	return merged ? ", PR слит автоматически" : ", автоматически слить не удалось";
}

async function finish(
	input: HandleInFlightInput,
	run: RunRow,
	prUrl: string,
	outcome: ReviewOutcome,
	report: string,
): Promise<null> {
	await input.emit(run.id, "plan_run.review_finished", {
		planRunId: input.planRun.id,
		seq: input.child.seq,
		outcome,
	});
	const mergeLine = await mergeIfPassed(input, run, prUrl, outcome);
	await input.commentOnPr?.(prUrl, `## ${OUTCOME_HEADINGS[outcome]}${mergeLine}\n\n${report}`);
	return null;
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
	if (await input.repos.events.hasKind(run.id, "plan_run.review_finished")) return null;

	const decision = decideReviewStep(await loadSteps(input.repos, run.id));
	if (decision.kind === "wait") {
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}
	if (decision.kind === "finished") {
		return await finish(input, run, prUrl, decision.outcome, decision.report);
	}
	if (run.branch === null) {
		return await finish(input, run, prUrl, "broken", "The run has no branch to review.");
	}

	const ticket = await describeTicket(input);
	const prompt =
		decision.step === "review"
			? `Review ${prUrl}. The fixed point of the diff is ${run.baseCommit ?? "the merge-base with the default branch"}.\n\n${ticket}`
			: `Fix these findings from the automated review of ${prUrl}.\n\n${decision.findings}\n\n${ticket}`;

	try {
		const spawned = await input.spawn({
			planRun: input.planRun,
			child: input.child,
			prompt,
			agentName: decision.step === "review" ? "reviewer" : "rework",
			existingBranch: run.branch,
		});
		await input.emit(run.id, "plan_run.review_step", {
			planRunId: input.planRun.id,
			seq: input.child.seq,
			step: decision.step,
			stepRunId: spawned.runId,
		});
		return { kind: "result", result: { kind: "dispatched", childRunId: spawned.runId } };
	} catch (err) {
		if (err instanceof PlanRunSpawnDeferredError) {
			return { kind: "result", result: { kind: "noop", reason: err.code } };
		}
		return await finish(input, run, prUrl, "broken", `The ${decision.step} run did not start.`);
	}
}
