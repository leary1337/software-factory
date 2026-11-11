import type { PlanRunChildRow, RunRow } from "@/api/types.ts";
import { formatCostUsd } from "../run-detail-format.ts";
import { type CostSummary, costText, taskCost } from "./cost-summary.ts";

export function CostNotes({ cost }: { cost: CostSummary }) {
	return (
		<div className="space-y-1 text-(--color-text-2) text-xs">
			<p>
				Includes implementation, reviews, reworks and retries in this attempt. Earlier plan attempts
				are separate.
			</p>
			<p>
				{cost.estimateRuns > 0
					? "Includes API-equivalent subscription estimates, not billed charges."
					: "Reported cost; subscription usage, when present, is an API-equivalent estimate rather than a charge."}
			</p>
			{cost.partial ? (
				<p className="text-(--color-warning)">
					Partial cost. {cost.unknownRuns > 0 ? `Unknown cost for ${cost.unknownRuns} runs. ` : ""}
					{cost.unavailableTasks > 0
						? `Task totals unavailable for ${cost.unavailableTasks} tasks. `
						: "Some execution history or measurements are unavailable. "}
					Unavailable measurements are not counted as zero.
				</p>
			) : null}
		</div>
	);
}

export function TaskCostPanel({ child, run }: { child: PlanRunChildRow; run: RunRow | undefined }) {
	const cost = taskCost(child);
	return (
		<section
			aria-label="Task cost"
			className="space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Task cost</h2>
			<dl className="grid gap-3 sm:grid-cols-2">
				<div>
					<dt className="text-(--color-text-2) text-xs">Whole task · this attempt</dt>
					<dd className="mt-1 font-semibold text-lg">{costText(cost)}</dd>
				</div>
				{run ? (
					<div>
						<dt className="text-(--color-text-2) text-xs">
							Current implementation run · included above
						</dt>
						<dd className="mt-1 text-sm">
							{run.costUsd === null ? "Unknown" : formatCostUsd(run.costUsd)}
						</dd>
					</div>
				) : null}
			</dl>
			<CostNotes cost={cost} />
		</section>
	);
}
