import {
	isTerminalRunState,
	type ReviewDisplayStatus,
	type ReviewGateResult,
	type ReviewStepKind,
	type ReviewVerdict,
	type RunState,
} from "./wire.ts";

/** The reviewer reports an explicit verdict, commit and quality-gate outcome. */
export function parseVerdict(text: string): ReviewVerdict | null {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const first = lines[0];
	if (first !== "VERDICT: PASS" && first !== "VERDICT: CHANGES") return null;
	if (lines.slice(1).some((line) => /^\s*VERDICT:/.test(line))) return null;
	return first === "VERDICT: PASS" ? "PASS" : "CHANGES";
}

export function passedReviewCommit(text: string): string | null {
	if (parseVerdict(text) !== "PASS") return null;
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const commit = /^REVIEWED_COMMIT: ([a-f0-9]{40})$/.exec(lines[1] ?? "")?.[1];
	if (!commit || lines[2] !== "QUALITY_GATE: PASS") return null;
	if (lines.slice(3).some((line) => /^\s*(?:REVIEWED_COMMIT:|QUALITY_GATE:|Not run:)/i.test(line)))
		return null;
	return commit;
}

export interface ReviewSummary {
	readonly gateVerified?: boolean;
	readonly status: ReviewDisplayStatus;
	readonly verdict: ReviewVerdict | null;
	readonly qualityGate: ReviewGateResult | null;
	readonly reviewedCommit: string | null;
	readonly reason: string | null;
}

export interface ReviewStepSummary {
	readonly runId: string;
	readonly step: ReviewStepKind;
	readonly executionState: RunState;
	readonly summary: ReviewSummary | null;
}

/** A presentation of the same strict report consumed by the merge gate. */
export function summarizeReview(
	text: string | null,
	state: RunState,
	failureReason: string | null = null,
	pinnedCommit?: string,
): ReviewSummary {
	const base = reviewFields(text);
	const { verdict, qualityGate, reviewedCommit } = base;
	if (!isTerminalRunState(state)) return { ...base, status: "pending" };
	if (state !== "succeeded" && failureReason !== "no_changes") {
		return {
			...base,
			status: "error",
			reason: "The review process did not complete successfully.",
		};
	}
	if (verdict === null || reviewedCommit === null || qualityGate === null) {
		return {
			...base,
			status: "error",
			reason: "The review did not return a complete verdict, commit and check result.",
		};
	}
	if (pinnedCommit && reviewedCommit !== pinnedCommit) {
		return {
			...base,
			status: "error",
			reason: "The report does not match the commit assigned for review.",
		};
	}
	if (verdict === "PASS" && passedReviewCommit(text ?? "") === null) {
		return {
			...base,
			status: "error",
			reason: "The PASS report did not confirm the complete quality gate.",
		};
	}
	if (qualityGate === "NOT_RUN") return { ...base, status: "checks_not_run" };
	return { ...base, status: verdict === "PASS" ? "passed" : "changes_requested" };
}

function reviewFields(text: string | null): Omit<ReviewSummary, "status"> {
	const lines = (text ?? "").replaceAll("\r\n", "\n").split("\n");
	const verdict = parseVerdict(text ?? "");
	const reviewedCommit = /^REVIEWED_COMMIT: ([a-f0-9]{40})$/.exec(lines[1] ?? "")?.[1] ?? null;
	const gate = /^QUALITY_GATE: (PASS|FAIL|NOT_RUN)$/.exec(lines[2] ?? "")?.[1];
	const qualityGate = gate === "PASS" || gate === "FAIL" || gate === "NOT_RUN" ? gate : null;
	const report = lines.slice(3).join("\n").trim().slice(0, 4000) || null;
	return { verdict, qualityGate, reviewedCommit, reason: report };
}
