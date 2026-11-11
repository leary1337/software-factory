import { useState } from "react";
import type { ReviewStepSummary } from "@/api/review-types.ts";
import { ReviewReport } from "../run-detail/review-report.tsx";

export function HistoryReport({
	step,
	label,
	latest,
}: {
	step: ReviewStepSummary;
	label: string;
	latest: boolean;
}) {
	const [open, setOpen] = useState(false);
	if (!step.summary) return null;
	const reason = step.summary.reason?.replace(/\s+/g, " ").trim();
	const excerpt = reason && reason.length > 220 ? `${reason.slice(0, 220).trimEnd()}…` : reason;
	return (
		<div className="space-y-2 text-sm">
			{latest && !open ? (
				<>
					<p className="text-(--color-text-2) text-xs">
						Quality gate: {step.summary.qualityGate ?? "not reported"} · Runtime checks:{" "}
						{step.summary.gateVerified ? "verified" : "not verified"}
					</p>
					{excerpt ? <p className="wrap-anywhere">{excerpt}</p> : null}
				</>
			) : null}
			<details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
				<summary className="cursor-pointer text-(--color-text-2)">Report for {label}</summary>
				{open ? (
					<div className="mt-2">
						<ReviewReport summary={step.summary} executionState={step.executionState} />
					</div>
				) : null}
			</details>
		</div>
	);
}
