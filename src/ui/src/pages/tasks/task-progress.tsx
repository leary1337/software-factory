import type { PlanRunChildRow } from "@/api/types.ts";

export function TaskProgress({ child }: { child: PlanRunChildRow }) {
	const index =
		child.state === "merged"
			? 3
			: child.reviewStage === "ready_to_merge"
				? 2
				: child.reviewStage
					? 1
					: 0;
	const reviews = child.reviewSteps?.filter((step) => step.step !== "rework").length ?? 0;
	const reworks = child.reviewSteps?.filter((step) => step.step === "rework").length ?? 0;
	return (
		<div className="space-y-2">
			<ol aria-label="Task progress" className="flex flex-wrap gap-2 text-xs">
				{["Implementation", "Review", "Delivery", "Complete"].map((label, step) => (
					<li
						key={label}
						aria-current={step === index ? "step" : undefined}
						className={`rounded border px-2 py-1 ${step === index ? "border-(--color-primary) font-semibold text-(--color-primary)" : "border-(--color-border) text-(--color-text-2)"}`}
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
