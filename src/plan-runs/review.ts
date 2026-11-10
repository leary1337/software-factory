/**
 * The factory's review step: between a child's PR opening and the human merge,
 * run `reviewer`, and on a CHANGES verdict run `rework` on the same branch,
 * up to {@link MAX_REWORKS} times. The steps are recorded as events on the
 * child's run, so the state survives a server restart with no new columns.
 *
 * Every code-changing step (the implementer, each rework) ends with warren's
 * post-run quality gate (docs/design/post-run-quality-gate.md). A red gate
 * goes straight to rework without a reviewer; a green one rides into the
 * reviewer's prompt so the reviewer does not run it again.
 */

import {
	isQualityGateGreen,
	QUALITY_GATE_EVENT_KIND,
	type QualityGateResult,
	qualityGateRan,
	readQualityGateResult,
} from "../core/quality-gate.ts";
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
	/** The post-run gate warren recorded on a finished rework, or null when none ran. */
	readonly gate?: QualityGateResult | null;
}

/** What sent the branch back to rework: the reviewer's findings or a red gate. */
export type ReworkCause = "review" | "gate";

export type ReviewDecision =
	| { readonly kind: "spawn"; readonly step: "review"; readonly gate: QualityGateResult | null }
	| {
			readonly kind: "spawn";
			readonly step: "rework";
			readonly findings: string;
			readonly cause: ReworkCause;
	  }
	| { readonly kind: "wait" }
	| { readonly kind: "finished"; readonly outcome: ReviewOutcome; readonly report: string };

export function parseVerdict(text: string): "PASS" | "CHANGES" | null {
	const match = text.match(/^VERDICT:\s*(PASS|CHANGES)\b/m);
	return (match?.[1] as "PASS" | "CHANGES" | undefined) ?? null;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The rework findings for a red gate: what failed, where, and its last output. */
export function describeRedGate(gate: QualityGateResult): string {
	const how = gate.timedOut
		? `was stopped after ${formatDuration(gate.durationMs)}`
		: `exited with code ${gate.exitCode ?? "unknown"}`;
	const where = gate.sha === null ? "the branch head" : `commit ${gate.sha}`;
	return `1. The project's quality gate \`${gate.command}\` ${how} on ${where}. Last output:\n\n\`\`\`\`text\n${gate.logTail}\`\`\`\``;
}

/** The reviewer's briefing on the gate warren already ran, or "" when there was none. */
export function describeGateForReviewer(gate: QualityGateResult | null): string {
	if (gate === null) return "";
	if (!qualityGateRan(gate)) {
		return `Warren could not run the quality gate \`${gate.command}\` in the sandbox (${gate.error}). Run it yourself.`;
	}
	if (!isQualityGateGreen(gate)) return "";
	if (gate.sha === null) {
		return `Warren ran the quality gate \`${gate.command}\` and it passed, but the commit it ran on is unknown. Run it yourself.`;
	}
	return `Warren ran the quality gate \`${gate.command}\` in the sandbox on commit ${gate.sha}, and it passed in ${formatDuration(gate.durationMs)}. When \`git diff --quiet ${gate.sha} HEAD -- . ':(exclude).seeds' ':(exclude).mulch'\` exits 0, that result covers the code you review: do not run the gate again.`;
}

const reworkCount = (steps: readonly ReviewStepRecord[]): number =>
	steps.filter((s) => s.step === "rework").length;

/** After the code changed: a red gate goes back to rework, anything else to review. */
function afterCodeChange(
	steps: readonly ReviewStepRecord[],
	gate: QualityGateResult | null,
): ReviewDecision {
	if (gate === null || !qualityGateRan(gate) || isQualityGateGreen(gate)) {
		return { kind: "spawn", step: "review", gate };
	}
	const findings = describeRedGate(gate);
	if (reworkCount(steps) >= MAX_REWORKS) {
		return { kind: "finished", outcome: "changes_left", report: findings };
	}
	return { kind: "spawn", step: "rework", findings, cause: "gate" };
}

/**
 * The next review action. `implementerGate` is the gate warren ran after the
 * implementer; each rework's own gate rides on its step record.
 */
export function decideReviewStep(
	steps: readonly ReviewStepRecord[],
	implementerGate: QualityGateResult | null = null,
): ReviewDecision {
	const last = steps.at(-1);
	if (last === undefined) return afterCodeChange(steps, implementerGate);
	if (last.state === "running") return { kind: "wait" };
	if (last.state === "failed") {
		return { kind: "finished", outcome: "broken", report: `The ${last.step} run failed.` };
	}
	if (last.step === "rework") return afterCodeChange(steps, last.gate ?? null);

	const report = last.resultText ?? "";
	const verdict = parseVerdict(report);
	if (verdict === null) {
		return { kind: "finished", outcome: "broken", report: "The review gave no verdict." };
	}
	if (verdict === "PASS") return { kind: "finished", outcome: "passed", report };
	if (reworkCount(steps) >= MAX_REWORKS) {
		return { kind: "finished", outcome: "changes_left", report };
	}
	return { kind: "spawn", step: "rework", findings: report, cause: "review" };
}

/** Where a child with an open PR actually is, for the plan view. */
export type ReviewStage = "reviewing" | "reworking" | "ready_to_merge" | "needs_attention";

export function reviewStageOf(
	steps: readonly ReviewStepRecord[],
	implementerGate: QualityGateResult | null = null,
): ReviewStage {
	const decision = decideReviewStep(steps, implementerGate);
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
	return reviewStageOf(await loadSteps(repos, runId), await readGate(repos, runId));
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
		const gateAfter = finishedCleanly && payload.step === "rework";
		records.push({
			step: payload.step,
			state: finishedCleanly ? "succeeded" : stepRun.endedAt === null ? "running" : "failed",
			resultText: finishedCleanly ? await readResultText(repos, stepRun.id) : null,
			...(gateAfter ? { gate: await readGate(repos, stepRun.id) } : {}),
		});
	}
	return records;
}

/** The post-run gate warren recorded on a run, or null when it ran none. */
async function readGate(repos: ReviewRepos, runId: string): Promise<QualityGateResult | null> {
	const row = await repos.events.latestOfKind(runId, QUALITY_GATE_EVENT_KIND, "system");
	return row === undefined ? null : readQualityGateResult(row.payloadJson);
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

type SpawnDecision = Extract<ReviewDecision, { kind: "spawn" }>;

function composeStepPrompt(
	decision: SpawnDecision,
	prUrl: string,
	run: RunRow,
	ticket: string,
): string {
	if (decision.step === "review") {
		const fixedPoint = run.baseCommit ?? "the merge-base with the default branch";
		const gate = describeGateForReviewer(decision.gate);
		const gateBlock = gate === "" ? "" : `\n\n${gate}`;
		return `Review ${prUrl}. The fixed point of the diff is ${fixedPoint}.${gateBlock}\n\n${ticket}`;
	}
	if (decision.cause === "gate") {
		return `Warren ran the project's quality gate on the branch of ${prUrl} after the last change, and it failed. Make it pass.\n\n${decision.findings}\n\n${ticket}`;
	}
	return `Fix these findings from the automated review of ${prUrl}.\n\n${decision.findings}\n\n${ticket}`;
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

	const [steps, implementerGate] = await Promise.all([
		loadSteps(input.repos, run.id),
		readGate(input.repos, run.id),
	]);
	const decision = decideReviewStep(steps, implementerGate);
	if (decision.kind === "wait") {
		return { kind: "result", result: { kind: "waiting_for_run" } };
	}
	if (decision.kind === "finished") {
		return await finish(input, run, prUrl, decision.outcome, decision.report);
	}
	if (run.branch === null) {
		return await finish(input, run, prUrl, "broken", "The run has no branch to review.");
	}

	const prompt = composeStepPrompt(decision, prUrl, run, await describeTicket(input));
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
			...(decision.step === "rework" ? { cause: decision.cause } : {}),
		});
		return { kind: "result", result: { kind: "dispatched", childRunId: spawned.runId } };
	} catch (err) {
		if (err instanceof PlanRunSpawnDeferredError) {
			return { kind: "result", result: { kind: "noop", reason: err.code } };
		}
		return await finish(input, run, prUrl, "broken", `The ${decision.step} run did not start.`);
	}
}
