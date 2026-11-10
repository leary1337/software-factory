import type { PlanRunChildRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";

export function TaskBudgetPanel({ child }: { child: PlanRunChildRow }) {
	const budget = child.budget;
	if (!budget) return null;
	return (
		<Alert
			className="text-(--color-fg)"
			title={budget.awaitingDispatch ? "Next run blocked by budget" : "Task and plan budgets"}
			variant={budget.blocked ? "warning" : "info"}
		>
			{budget.reason ? <p>{budget.reason}</p> : null}
			{budget.nextAction ? <p className="mt-2">{budget.nextAction}</p> : null}
			<div className="mt-3 grid gap-3 sm:grid-cols-2">
				{(["task", "plan"] as const).map((scope) => {
					const limits = budget.limits[scope];
					if (!limits) return null;
					const usage = budget[scope];
					return (
						<div key={scope} className="space-y-1 text-sm">
							<h3 className="font-semibold">{scope === "task" ? "This task" : "Entire plan"}</h3>
							{limits.maxRuns !== undefined ? (
								<p>
									Runs: {usage.runs} / {limits.maxRuns}
								</p>
							) : null}
							{limits.maxActiveMs !== undefined ? (
								<p>
									Active time: {Math.round(usage.activeMs / 60_000)} /{" "}
									{Math.round(limits.maxActiveMs / 60_000)} min
								</p>
							) : null}
							{limits.maxCostUsd !== undefined ? (
								<p>
									Reported cost / estimate: ${usage.costUsd.toFixed(2)} / $
									{limits.maxCostUsd.toFixed(2)}
								</p>
							) : null}
						</div>
					);
				})}
			</div>
			<p className="mt-3 text-xs">
				Checked before the next run starts. These limits do not interrupt a running step or measure
				remaining subscription quota.
			</p>
		</Alert>
	);
}
