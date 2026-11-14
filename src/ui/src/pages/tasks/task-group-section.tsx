import type { ReactNode } from "react";
import type { TaskGroup } from "./task-status.ts";

export function TaskGroupSection({
	group,
	title,
	count,
	searching,
	children,
}: {
	group: TaskGroup;
	title: string;
	count: number;
	searching: boolean;
	children: ReactNode;
}) {
	const heading = (
		<>
			{title} <span className="text-(--color-text-2)">({count})</span>
		</>
	);
	if (group === "history" || group === "stopped" || group === "closed" || group === "complete")
		return (
			<section aria-label={title}>
				<details open={searching || undefined} className="space-y-3">
					<summary className="cursor-pointer font-semibold text-base">{heading}</summary>
					{children}
				</details>
			</section>
		);
	return (
		<section aria-label={title} className="space-y-3">
			<h2 className="font-semibold text-base">{heading}</h2>
			{children}
		</section>
	);
}
