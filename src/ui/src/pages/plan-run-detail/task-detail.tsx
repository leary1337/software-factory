import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunDetailResponse } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { TaskCostPanel } from "../tasks/cost-panel.tsx";
import { TaskActivity } from "../tasks/task-activity.tsx";
import { TaskBudgetPanel } from "../tasks/task-budget-panel.tsx";
import { TaskMetricsPanel } from "../tasks/task-metrics-panel.tsx";
import { TaskProgress } from "../tasks/task-progress.tsx";
import { taskStatus } from "../tasks/task-status.ts";
import { DeploymentIncident } from "./deployment-incident.tsx";
import { TaskHistory } from "./task-history.tsx";

export function TaskDetail({
	detail,
	child,
}: {
	detail: PlanRunDetailResponse;
	child: PlanRunChildRow;
}) {
	const run = detail.runs.find((entry) => entry.id === child.runId);
	const status = taskStatus(child, detail.planRun);
	return (
		<div className="flex min-h-full flex-col gap-4 px-3.5 py-6 md:px-6">
			<Link
				to={`/plan-runs/${encodeURIComponent(detail.planRun.id)}`}
				className="text-(--color-primary) text-sm hover:underline"
			>
				← Back to plan
			</Link>
			<Link to="/tasks" className="text-(--color-primary) text-sm">
				All tasks
			</Link>
			<header className="flex flex-wrap items-center gap-3">
				<h1 className="min-w-0 break-words font-semibold text-xl">
					{child.title ?? `Task ${child.seq}`}
				</h1>
				<span className="rounded border border-(--color-border) px-2 py-1 text-xs">
					{status.label}
				</span>
				{run?.prUrl ? (
					<a
						href={run.prUrl}
						target="_blank"
						rel="noreferrer noopener"
						className="text-(--color-primary) text-sm hover:underline"
					>
						Open pull request ↗
					</a>
				) : null}
			</header>
			<TaskProgress child={child} />
			<Alert
				className="text-(--color-fg)"
				title={status.group === "attention" ? "Action required" : "Current status"}
				variant={status.group === "attention" ? "warning" : "info"}
			>
				{status.action}
			</Alert>
			<p className="text-(--color-text-2) text-sm">
				Task {child.seq} of {detail.children.length}
			</p>
			{status.group === "active" ? <TaskActivity child={child} /> : null}
			<TaskMergeStatus child={child} />
			<TaskBudgetPanel child={child} />
			{child.failureReason === "deployment_incident" ? (
				<DeploymentIncident planRunId={detail.planRun.id} runId={child.runId} />
			) : child.failureReason ? (
				<Alert className="text-(--color-fg)" title="Task stopped" variant="danger">
					{child.failureReason}
				</Alert>
			) : null}
			<TaskCostPanel child={child} run={run} />
			<TaskHistory key={`${child.planRunId}:${child.seq}`} child={child} run={run} />
			{child.metrics ? (
				<details className="rounded border border-(--color-border) p-4">
					<summary className="cursor-pointer font-medium text-sm">Task totals</summary>
					<div className="mt-3">
						<TaskMetricsPanel child={child} />
					</div>
				</details>
			) : null}
			{run?.prompt ? (
				<details className="rounded border border-(--color-border) bg-(--color-surface) p-4">
					<summary className="cursor-pointer font-medium text-sm">Task instructions</summary>
					<p className="wrap-anywhere mt-3 whitespace-pre-wrap text-sm">{run.prompt}</p>
				</details>
			) : null}
		</div>
	);
}

function TaskMergeStatus({ child }: { child: PlanRunChildRow }) {
	if (child.prMergedAt || child.failureReason === "deployment_incident") return null;
	return (
		<>
			{child.reviewMerge && child.reviewMerge.kind !== "merged" ? (
				<Alert
					title="Merge status"
					variant={child.reviewMerge.kind === "blocked" ? "warning" : "info"}
					className="text-(--color-fg)"
				>
					<p>{child.reviewMerge.detail}</p>
					<p className="mt-2 font-medium">{child.reviewMerge.nextAction}</p>
					{child.reviewMerge.paths?.length ? (
						<ul className="mt-2 list-inside list-disc break-all">
							{child.reviewMerge.paths.map((path) => (
								<li key={path}>{path}</li>
							))}
						</ul>
					) : null}
				</Alert>
			) : null}
		</>
	);
}
