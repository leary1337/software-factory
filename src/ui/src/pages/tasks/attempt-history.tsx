import { Link } from "react-router-dom";
import { formatTimestamp } from "@/lib/utils.ts";
import { type TaskAttempt, taskUrl } from "./task-attempts.ts";
import { taskStatus } from "./task-status.ts";

export function AttemptHistory({
	attempts,
	selected,
}: {
	attempts: readonly TaskAttempt[];
	selected: TaskAttempt;
}) {
	return (
		<details className="space-y-2 border-(--color-border) border-t pt-3 text-sm">
			<summary className="cursor-pointer font-medium">Attempt history ({attempts.length})</summary>
			<ul className="mt-3 space-y-3">
				{attempts.map((attempt) => (
					<li key={taskUrl(attempt)} className="space-y-1">
						<Link className="text-(--color-primary) hover:underline" to={taskUrl(attempt)}>
							{formatTimestamp(attempt.detail.planRun.createdAt)} ·{" "}
							{taskStatus(attempt.child, attempt.detail.planRun).label}
						</Link>
						<p className="wrap-anywhere text-(--color-text-2) text-xs">
							{attempt.detail.planRun.planName ?? "Plan attempt"}
							{taskUrl(attempt) === taskUrl(selected) ? " · This attempt" : ""}
						</p>
					</li>
				))}
			</ul>
		</details>
	);
}
