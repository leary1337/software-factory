import { Link } from "react-router-dom";
import { formatTimestamp } from "@/lib/utils.ts";
import { CostCalculation } from "./cost-calculation.tsx";
import { CostNotes } from "./cost-panel.tsx";
import { costText, sumCosts, taskCost } from "./cost-summary.ts";
import { type TaskAttempt, taskUrl } from "./task-attempts.ts";
import { taskStatus } from "./task-status.ts";

export function AttemptCosts({
	attempts,
	selected,
}: {
	attempts: readonly TaskAttempt[];
	selected: TaskAttempt;
}) {
	const rows = attempts.map((attempt) => ({
		key: taskUrl(attempt),
		label: (
			<Link className="text-(--color-primary) hover:underline" to={taskUrl(attempt)}>
				{formatTimestamp(attempt.detail.planRun.createdAt)} ·{" "}
				{taskStatus(attempt.child, attempt.detail.planRun).label}
			</Link>
		),
		cost: taskCost(attempt.child),
	}));
	const total = sumCosts(rows.map((row) => row.cost));
	return (
		<div className="space-y-2 border-(--color-border) border-t pt-3 text-sm">
			<p className="font-medium">
				Across {attempts.length} loaded {attempts.length === 1 ? "attempt" : "attempts"}:{" "}
				{costText(total)}
			</p>
			<p className="text-(--color-text-2) text-xs">
				This task only. Includes the selected attempt; each attempt is counted once.
			</p>
			<details>
				<summary className="cursor-pointer font-medium">
					Attempt history ({attempts.length})
				</summary>
				<div className="mt-3 space-y-3">
					<ul className="space-y-3">
						{attempts.map((attempt, index) => (
							<li key={taskUrl(attempt)} className="space-y-1">
								{rows[index]?.label}
								<p className="wrap-anywhere text-(--color-text-2) text-xs">
									{attempt.detail.planRun.planName ?? "Plan attempt"}
									{taskUrl(attempt) === taskUrl(selected) ? " · This attempt" : ""} · Task cost:{" "}
									{costText(taskCost(attempt.child))}
								</p>
							</li>
						))}
					</ul>
					<CostNotes cost={total} acrossAttempts />
					<CostCalculation rows={rows} />
				</div>
			</details>
		</div>
	);
}
