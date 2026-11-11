import type { PlanRunChildRow, RunRow } from "@/api/types.ts";
import { formatCostUsd } from "../run-detail-format.ts";
import { CostCalculation } from "./cost-calculation.tsx";
import { type CostSummary, costText, planCost, taskCost } from "./cost-summary.ts";

export function CostNotes({
	cost,
	acrossAttempts = false,
}: {
	cost: CostSummary;
	acrossAttempts?: boolean;
}) {
	return (
		<div className="space-y-1 text-(--color-text-2) text-xs">
			<p>
				{acrossAttempts
					? "Includes implementation, reviews, reworks and retries across the loaded attempts shown here."
					: "Includes implementation, reviews, reworks and retries in this attempt. Earlier plan attempts are separate."}
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
			<CostCalculation rows={[{ key: "task", label: "Whole task · this attempt", cost }]} />
		</section>
	);
}

export function PlanCostPanel({ children }: { children: readonly PlanRunChildRow[] }) {
	const rows = children.map((child) => ({
		key: String(child.seq),
		label: `Task ${child.seq} · ${child.title ?? "Untitled task"}`,
		cost: taskCost(child),
	}));
	const cost = planCost(children);
	return (
		<section
			aria-label="Plan cost"
			className="mb-4 space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4"
		>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<div>
					<h2 className="font-semibold text-base">Plan cost</h2>
					<p className="text-(--color-text-2) text-xs">All tasks · this attempt</p>
				</div>
				<p className="font-semibold text-xl tabular-nums">{costText(cost)}</p>
			</div>
			<CostNotes cost={cost} />
			<CostCalculation rows={rows} />
		</section>
	);
}
