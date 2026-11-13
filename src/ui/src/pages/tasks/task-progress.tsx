import type { PlanRunChildRow, PlanRunRow } from "@/api/types.ts";
import { taskStatus } from "./task-status.ts";

export function TaskProgress({ child, plan }: { child: PlanRunChildRow; plan: PlanRunRow }) {
	if (child.state === "skipped" || child.state === "pending") return null;
	const { phase, group } = taskStatus(child, plan);
	const currentTone =
		group === "attention"
			? "border-(--color-warning) text-(--color-warning)"
			: "border-(--color-primary) text-(--color-primary)";
	const reviews = child.reviewSteps?.filter((step) => step.step !== "rework").length ?? 0;
	const reworks = child.reviewSteps?.filter((step) => step.step === "rework").length ?? 0;
	return (
		<div className="space-y-2">
			<ol aria-label="Task progress" className="flex flex-wrap gap-2 text-xs">
				{["Implementation", "Review", "Delivery", "Complete"].map((label) => (
					<li
						key={label}
						aria-current={label === phase ? "step" : undefined}
						className={`rounded border px-2 py-1 ${label === phase ? `font-semibold ${currentTone}` : "border-(--color-border) text-(--color-text-2)"}`}
					>
						{label}
					</li>
				))}
			</ol>
			{reviews + reworks > 0 ? (
				<p className="text-(--color-text-2) text-xs">
					{reviews} review{reviews === 1 ? "" : "s"} · {reworks} rework{reworks === 1 ? "" : "s"}
				</p>
			) : null}
		</div>
	);
}
