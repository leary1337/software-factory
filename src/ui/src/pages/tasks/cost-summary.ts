import type { PlanRunChildRow } from "../../api/types.ts";
import { formatCostUsd } from "../run-detail-format.ts";

/** Presentation of domain-provided task metrics; never infer a whole task from its current run. */
export interface CostSummary {
	amount: number | null;
	unknownRuns: number;
	unavailableTasks: number;
	partial: boolean;
	estimateRuns: number;
	runCount: number;
}

export function taskCost(child: PlanRunChildRow): CostSummary {
	const metrics = child.metrics;
	if (!metrics)
		return {
			amount: null,
			unknownRuns: 0,
			unavailableTasks: 1,
			partial: true,
			estimateRuns: 0,
			runCount: 0,
		};
	const noExecutions =
		metrics.runCount === 0 && !metrics.incomplete && metrics.missingRunCount === 0;
	const amount = noExecutions ? 0 : metrics.costUsd;
	return {
		amount,
		unknownRuns: metrics.costUnknownRuns,
		unavailableTasks: 0,
		partial: metrics.incomplete || metrics.costUnknownRuns > 0 || amount === null,
		estimateRuns: metrics.subscriptionEstimateRuns,
		runCount: metrics.runCount,
	};
}

export function planCost(children: readonly PlanRunChildRow[]): CostSummary {
	const costs = children.map(taskCost);
	const known = costs.flatMap((cost) => (cost.amount === null ? [] : [cost.amount]));
	return {
		amount:
			known.length > 0 || children.length === 0
				? known.reduce((sum, amount) => sum + amount, 0)
				: null,
		unknownRuns: costs.reduce((sum, cost) => sum + cost.unknownRuns, 0),
		unavailableTasks: costs.reduce((sum, cost) => sum + cost.unavailableTasks, 0),
		partial: costs.some((cost) => cost.partial),
		estimateRuns: costs.reduce((sum, cost) => sum + cost.estimateRuns, 0),
		runCount: costs.reduce((sum, cost) => sum + cost.runCount, 0),
	};
}

export function costText(cost: CostSummary): string {
	if (cost.amount === null) return "Unknown";
	return `${formatCostUsd(cost.amount)}${cost.partial ? " + unknown" : ""}`;
}

export function implementationLimitText(limit: number | null | undefined): string {
	if (limit === undefined) return "Unavailable";
	return limit === null ? "No limit declared" : formatCostUsd(limit);
}
