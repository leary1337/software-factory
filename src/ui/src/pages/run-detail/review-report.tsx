import type { ReviewSummary } from "@/api/review-types.ts";
import type { RunRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";

const LABELS = {
	passed: "Review passed",
	changes_requested: "Changes requested",
	checks_not_run: "Checks not run",
	error: "Review error",
	pending: "Review in progress",
} as const;

/** Execution completion and review approval are independent facts. */
export function ReviewReport({
	summary,
	executionState,
}: {
	summary: ReviewSummary;
	executionState: RunRow["state"];
}) {
	const variant =
		summary.status === "passed"
			? "success"
			: summary.status === "error"
				? "danger"
				: summary.status === "pending"
					? "info"
					: "warning";
	return (
		<Alert variant={variant} className="shrink-0 text-(--color-fg)">
			<h2 className="font-semibold text-sm">{LABELS[summary.status]}</h2>
			<p className="mt-1 text-xs">Execution: {executionState}</p>
			{summary.verdict ? (
				<p className="text-xs">
					Verdict: {summary.verdict} · Quality gate: {summary.qualityGate ?? "not reported"}
				</p>
			) : null}
			<p className="text-xs">
				Independent runtime checks: {summary.gateVerified ? "verified" : "not verified"}
			</p>
			{summary.reviewedCommit ? (
				<p className="break-all font-mono text-xs">Reviewed commit: {summary.reviewedCommit}</p>
			) : null}
			{summary.reason ? (
				<p className="wrap-anywhere mt-2 whitespace-pre-wrap text-sm">{summary.reason}</p>
			) : null}
		</Alert>
	);
}
