import { pinnedChangesReport } from "../../core/review-check-failure.ts";
import type { ReviewGateResult } from "../../core/wire.ts";
import type { AdapterRuntimeEvent } from "../adapters/index.ts";
import type { LocalRunRecord, LocalRunStore } from "./run-store.ts";

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
