import { pinnedChangesReport } from "../../core/review-check-failure.ts";
import type { ReviewGateResult } from "../../core/wire.ts";
import type { AdapterRuntimeEvent } from "../adapters/index.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

/** Keep reported usage when verification replaces the model's success with failure. */
export function preserveFailedReviewUsage(
	store: LocalRunStore,
	record: LocalRunRecord,
	deferred: readonly AdapterRuntimeEvent[],
): void {
	if (record.cancelRequested) return;
	const result = [...deferred]
		.reverse()
		.find(
			(event) =>
				typeof event.payload === "object" &&
				event.payload !== null &&
				"type" in event.payload &&
				event.payload.type === "result",
		);
	if (!result || typeof result.payload !== "object" || result.payload === null) return;
	if (!("total_cost_usd" in result.payload) && !("usage" in result.payload)) return;
	store.appendEvent(record, {
		kind: "state_change",
		stream: "system",
		payload: {
			...result.payload,
			is_error: true,
			synthesized: true,
			source_type: "verification_failed",
		},
	});
}

export class QualityGateFailure extends Error {
	constructor(
		readonly commit: string,
		readonly exitCode: number,
		readonly qualityGate: Exclude<ReviewGateResult, "NOT_RUN"> = "FAIL",
	) {
		super(
			qualityGate === "PASS"
				? `Acceptance criteria were not verified (exit ${exitCode})`
				: `Independent quality gate failed (exit ${exitCode})`,
		);
	}
}

/** Preserve CHANGES without replaying a success terminal envelope after a failing gate. */
export function recordFailedGateReview(
	store: LocalRunStore,
	record: LocalRunRecord,
	error: unknown,
	agentExitCode: number,
	streamError: unknown,
	deferred: readonly AdapterRuntimeEvent[],
): void {
	if (
		!(error instanceof QualityGateFailure) ||
		agentExitCode !== 0 ||
		streamError !== undefined ||
		record.cancelRequested ||
		error.exitCode <= 0
	)
		return;
	const result = [...deferred]
		.reverse()
		.map((event) => {
			const payload = event.payload;
			return typeof payload === "object" && payload !== null && "result" in payload
				? payload.result
				: undefined;
		})
		.find((value) => typeof value === "string");
	const report = pinnedChangesReport(result, error.commit, error.qualityGate);
	if (!report) return;
	store.appendEvent(record, {
		kind: "review.check_failed",
		stream: "system",
		payload: {
			commit: error.commit,
			exitCode: error.exitCode,
			qualityGate: error.qualityGate,
			agentExitCode,
			report,
		},
	});
}
