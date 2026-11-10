import { summarizeReviewEvidence } from "@/api/review-types.ts";
import type { RunEvent, RunRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import type { StreamStatus } from "@/hooks/use-event-stream.helpers.ts";
import { ReviewReport } from "./review-report.tsx";

function finalReport(events: readonly RunEvent[]): string | null {
	for (const event of [...events].reverse()) {
		const payload = event.payload;
		if (typeof payload !== "object" || payload === null) continue;
		if (
			"type" in payload &&
			payload.type === "result" &&
			"result" in payload &&
			typeof payload.result === "string"
		)
			return payload.result;
	}
	return null;
}

export function RunReviewPanel({
	run,
	events,
	status,
}: {
	run: RunRow;
	events: readonly RunEvent[];
	status: StreamStatus;
}) {
	if (run.agentName !== "reviewer") return null;
	if (status === "error")
		return (
			<Alert className="text-(--color-fg)" variant="danger" title="Review result unavailable">
				Reconnect or reload to read the review result. Execution status alone does not indicate
				approval.
			</Alert>
		);
	const report = finalReport(events);
	if (report === null && status !== "ended")
		return (
			<Alert className="text-(--color-fg)" title="Loading review result">
				Execution: {run.state}
			</Alert>
		);
	return (
		<ReviewReport
			summary={summarizeReviewEvidence(
				report,
				run.state,
				run.failureReason,
				run.baseCommit ?? undefined,
				events.map((event) => ({ ...event, payloadJson: event.payload })),
			)}
			executionState={run.state}
		/>
	);
}
