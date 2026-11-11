import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunRow } from "../../api/types.ts";
import { planProgressText } from "./plan-progress-summary.ts";
import { taskStatus } from "./task-status.ts";

export function PlanProgress({ plan, tasks }: { plan: PlanRunRow; tasks: PlanRunChildRow[] }) {
	const current = [...tasks]
		.sort((a, b) => a.seq - b.seq)
		.find((child) => child.state !== "merged" && child.state !== "skipped");
	return (
		<section
			aria-label="Plan progress"
			className="mb-4 space-y-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Plan progress</h2>
			{current ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<span className="font-medium">
						Task {current.seq} of {tasks.length}
					</span>
					<Link
						className="break-words text-(--color-primary) hover:underline"
						to={`/plan-runs/${encodeURIComponent(plan.id)}?task=${current.seq}`}
					>
						{current.title ?? `Task ${current.seq}`}
					</Link>
					<span>{taskStatus(current, plan).label}</span>
				</div>
			) : (
				<p className="text-sm">No remaining tasks in this attempt.</p>
			)}
			<p className="text-(--color-text-2) text-sm">{planProgressText(tasks, plan.state)}</p>
			{tasks.some((child) => child.state === "skipped") ? (
				<p className="text-(--color-text-2) text-xs">
					Previously closed tasks were closed in the tracker before dispatch. Delivery is not
					confirmed by that status.
				</p>
			) : null}
		</section>
	);
}
