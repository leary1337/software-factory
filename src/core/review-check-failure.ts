import type { QualityGateEvent } from "./quality-gate.ts";
import { parseVerdict } from "./review-result.ts";
import type { ReviewGateResult } from "./wire.ts";

/** A failing test is review evidence only when the reviewer finished with pinned CHANGES. */
export function pinnedChangesReport(
	report: unknown,
	commit: string,
	qualityGate: Exclude<ReviewGateResult, "NOT_RUN"> = "FAIL",
): string | null {
	if (typeof report !== "string" || !/^[a-f0-9]{40}$/.test(commit)) return null;
	const lines = report.replaceAll("\r\n", "\n").split("\n");
	if (
		parseVerdict(report) !== "CHANGES" ||
		lines[1] !== `REVIEWED_COMMIT: ${commit}` ||
		!/^QUALITY_GATE: (PASS|FAIL|NOT_RUN)$/.test(lines[2] ?? "")
	)
		return null;
	lines[2] = `QUALITY_GATE: ${qualityGate}`;
	return lines.join("\n");
}

/** The host writes this receipt only after a clean model exit and safe gate cleanup. */
export function failedGateChangesReport(
	events: readonly QualityGateEvent[],
	commit: string,
): string | null {
	const event = [...events]
		.reverse()
		.find(
			(candidate) =>
				candidate.stream === "system" &&
				["review.check_failed", "quality_gate.started"].includes(candidate.kind),
		);
	if (event?.kind !== "review.check_failed") return null;
	const data = event.payloadJson;
	if (typeof data !== "object" || data === null) return null;
	const receipt = data as Record<string, unknown>;
	if (
		receipt.commit !== commit ||
		receipt.agentExitCode !== 0 ||
		typeof receipt.exitCode !== "number" ||
		!Number.isInteger(receipt.exitCode) ||
		receipt.exitCode <= 0
	)
		return null;
	return pinnedChangesReport(
		receipt.report,
		commit,
		receipt.qualityGate === "PASS" ? "PASS" : "FAIL",
	);
}
