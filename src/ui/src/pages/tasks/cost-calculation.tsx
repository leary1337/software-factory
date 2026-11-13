import type { ReactNode } from "react";
import { type CostSummary, preciseCostText, roundingAdjustment, sumCosts } from "./cost-summary.ts";

export interface CostLine {
	key: string;
	label: ReactNode;
	cost: CostSummary;
}

export function CostCalculation({ rows }: { rows: readonly CostLine[] }) {
	const costs = rows.map((row) => row.cost);
	const adjustment = roundingAdjustment(costs);
	return (
		<div className="space-y-2 text-(--color-text-2) text-xs">
			<p>
				Totals use the original measurements before rounding. Displayed rows may not add up exactly.
			</p>
			<details className="text-sm">
				<summary className="cursor-pointer">Cost calculation</summary>
				<div className="mt-3 space-y-3">
					<p className="text-xs">
						USD · 6 decimal places. Unknown measurements are excluded from the known sum.
					</p>
					<ul className="space-y-2">
						{rows.map((row) => (
							<li key={row.key} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
								<span className="wrap-anywhere min-w-0">{row.label}</span>
								<span className="shrink-0 font-mono tabular-nums">{preciseCostText(row.cost)}</span>
							</li>
						))}
					</ul>
					<p className="font-medium text-(--color-text)">
						Total: {preciseCostText(sumCosts(costs))}
					</p>
					{adjustment ? (
						<p>
							Rounding adjustment: {adjustment}. This is a display difference, not an extra charge.
						</p>
					) : null}
				</div>
			</details>
		</div>
	);
}
