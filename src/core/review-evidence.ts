import { readAcceptanceSummary } from "./acceptance-evidence.ts";
import {
	hasQualityGateWitness,
	type QualityGateEvent,
	reportWithVerifiedGate,
} from "./quality-gate.ts";
import { failedGateChangesReport } from "./review-check-failure.ts";
import { type ReviewSummary, summarizeReview } from "./review-result.ts";
import type { RunState } from "./wire.ts";

/** Combine a reported review with the control plane's independent check witness. */
export function summarizeReviewEvidence(
	text: string | null,
	state: RunState,
	failureReason: string | null,
	commit: string | undefined,
	events: readonly QualityGateEvent[],
): ReviewSummary {
	const gateVerified = commit !== undefined && hasQualityGateWitness(events, commit);
	const findings =
		state === "failed" && failureReason === "crashed" && commit
			? failedGateChangesReport(events, commit)
			: null;
	const report =
		findings ?? (gateVerified && text !== null ? reportWithVerifiedGate(text, commit) : text);
	const summary = {
		...summarizeReview(report, findings ? "succeeded" : state, failureReason, commit),
		acceptance: readAcceptanceSummary(events, commit),
	};
	if (summary.status === "passed" && !gateVerified)
		return {
			...summary,
			gateVerified,
			status: "checks_not_run",
			reason: "The runtime has not verified the quality gate for this commit.",
		};
	return { ...summary, gateVerified };
}
