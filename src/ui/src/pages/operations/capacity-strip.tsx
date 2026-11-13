import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import type { RunRow } from "@/api/types.ts";
import { cn } from "@/lib/utils.ts";
import type { OpsWindow } from "../../../../core/wire.ts";
import { formatDurationMs, oldestPhaseInstant } from "./operations.helpers.ts";

interface CapacityCellSpec {
	readonly label: string;
	readonly value: string;
	readonly unit?: string;
	readonly detail: string;
}

function CapacityCell({
	label,
	value,
	unit,
	detail,
	className,
}: CapacityCellSpec & { className?: string }) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-[5px] p-3 sm:flex-1 sm:gap-2 sm:px-3.5 sm:pt-3 sm:pb-2.5",
				className,
			)}
		>
			<span className="font-mono text-(--color-text-3) text-[9px] leading-[11px] tracking-[0.08em] sm:leading-3 sm:tracking-[0.07em]">
				{label}
			</span>
			<span className="flex items-baseline gap-1 sm:gap-[7px]">
				<span className="font-mono font-semibold text-(--color-text) text-[18px] leading-[22px] tracking-[-0.03em] sm:font-medium sm:text-xl sm:leading-6">
					{value}
				</span>
				{unit ? (
					<span className="w-max shrink-0 font-mono text-(--color-text-3) text-[10px] leading-3">
						{unit}
					</span>
				) : null}
			</span>
			<span className="font-mono text-(--color-text-3) text-[9px] leading-[11px] sm:leading-3">
				{detail}
			</span>
		</div>
	);
}

export function CapacityStrip({
	overview,
	runs,
	now,
	window: _window = "24h",
}: {
	overview: OpsOverviewResponse | undefined;
	runs: readonly RunRow[] | undefined;
	now: number;

	window?: OpsWindow;
}) {
	if (overview === undefined) {
		return (
			<div className="rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) px-3.5 py-3 font-mono text-(--color-text-3) text-[10px] leading-3">
				loading snapshot…
			</div>
		);
	}
	const running = overview.runs.byState.running ?? 0;
	const queued = overview.runs.byState.queued ?? 0;
	const nonTerminal = overview.runs.nonTerminal;
	// Oldest phases come from the newest-runs window (the same shared
	// ["runs"] query the shell uses) — the snapshot endpoint carries no
	// per-state age. Null window = "unknown", never 0.
	const oldestQueued = runs ? oldestPhaseInstant(runs, "queued") : null;
	const oldestQueuedLabel =
		runs === undefined
			? "oldest queued unknown"
			: oldestQueued === null
				? "queue empty"
				: `oldest queued ${formatDurationMs(now - oldestQueued)}`;
	const delivery = overview.delivery;

	const cells: CapacityCellSpec[] = [
		{
			label: "RUNNING",
			value: String(running),
			unit: "ACTIVE",
			detail: `${nonTerminal} occupying admission slots · ${overview.runs.total} total`,
		},
		{
			label: "QUEUE DEPTH",
			value: String(queued),
			unit: "RUNS",
			detail: oldestQueuedLabel,
		},
	];
	if (delivery !== undefined) {
		cells.push({
			label: "DELIVERY",
			value: String(delivery.branchesPushed),
			unit: "BRANCHES",
			detail: `${delivery.prsOpened} PRs opened · ${delivery.prsMerged} merged`,
		});
	}

	// Mobile hairlines (warren-10d3): a 2x2 grid wants a right hairline
	// on cells with a right neighbour (left column, and the lone cell of
	// an odd last row has none) and a bottom hairline on every row but
	// the last. sm+ keeps the row layout's per-cell right hairline.
	const rowCount = Math.ceil(cells.length / 2);

	return (
		<div className="grid min-w-0 grid-cols-2 overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) sm:flex sm:flex-row">
			{cells.map((cell, i) => (
				<CapacityCell
					key={cell.label}
					{...cell}
					className={cn(
						i % 2 === 0 && i + 1 < cells.length && "border-(--color-border) border-r",
						i < 2 * (rowCount - 1) && "border-(--color-border) border-b sm:border-b-0",
						"sm:border-r sm:border-r-(--color-border)",
					)}
				/>
			))}
		</div>
	);
}
