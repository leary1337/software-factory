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
	return sumCosts(children.map(taskCost));
}

export function sumCosts(costs: readonly CostSummary[]): CostSummary {
	const known = costs.flatMap((cost) => (cost.amount === null ? [] : [cost.amount]));
	return {
		amount:
			known.length > 0 || costs.length === 0
				? known.reduce((sum, amount) => sum + amount, 0)
				: null,
		unknownRuns: costs.reduce((sum, cost) => sum + cost.unknownRuns, 0),
		unavailableTasks: costs.reduce((sum, cost) => sum + cost.unavailableTasks, 0),
		partial: costs.some((cost) => cost.partial),
		estimateRuns: costs.reduce((sum, cost) => sum + cost.estimateRuns, 0),
		runCount: costs.reduce((sum, cost) => sum + cost.runCount, 0),
	};
}

export function preciseCostText(cost: CostSummary): string {
	if (cost.amount === null) return "Unknown";
	const amount =
		cost.amount > 0 && cost.amount < 0.000001 ? "<$0.000001" : `$${cost.amount.toFixed(6)}`;
	return `${amount}${cost.partial ? " + unknown" : ""}`;
}

/** Explain the difference between rounded rows and a total computed from original values. */
export function roundingAdjustment(costs: readonly CostSummary[]): string | null {
	const total = sumCosts(costs);
	if (total.amount === null) return null;
	const rounded = (amount: number) => Number(formatCostUsd(amount).slice(1));
	const rows = costs.reduce(
		(sum, cost) => sum + (cost.amount === null ? 0 : rounded(cost.amount)),
		0,
	);
	const adjustment = Number((rounded(total.amount) - rows).toFixed(6));
	if (adjustment === 0) return null;
	const amount = Math.abs(adjustment);
	return `${adjustment > 0 ? "+" : "−"}$${amount.toFixed(3).replace(/0$/, "")}`;
}

export function costText(cost: CostSummary): string {
	if (cost.amount === null) return "Unknown";
	return `${formatCostUsd(cost.amount)}${cost.partial ? " + unknown" : ""}`;
}

export function implementationLimitText(limit: number | null | undefined): string {
	if (limit === undefined) return "Unavailable";
	return limit === null ? "No limit declared" : formatCostUsd(limit);
}
