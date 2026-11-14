import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunDetailResponse } from "@/api/types.ts";
import { useWorkspaceReturn } from "@/components/console/workspace-navigation.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { TaskActivity } from "../tasks/task-activity.tsx";
import { TaskBudgetPanel } from "../tasks/task-budget-panel.tsx";
import { taskCopy } from "../tasks/task-copy.ts";
import { TaskMetricsPanel } from "../tasks/task-metrics-panel.tsx";
import { TaskProgress } from "../tasks/task-progress.tsx";
import { taskStatus } from "../tasks/task-status.ts";
import { TaskStatusMessage } from "../tasks/task-status-message.tsx";
import { AttemptHistoryPanel } from "./attempt-history-panel.tsx";
import { DeploymentIncident } from "./deployment-incident.tsx";
import { RetryReview } from "./retry-review.tsx";
import { TaskHistory } from "./task-history.tsx";

export function TaskDetail({
	detail,
	child,
}: {
	detail: PlanRunDetailResponse;
	child: PlanRunChildRow;
}) {
	const run = detail.runs.find((entry) => entry.id === child.runId);
	const approved = detail.approval?.snapshot.tasks.find((task) => task.seq === child.seq);
	const status = taskStatus(child, detail.planRun);
	const backToPlan = useWorkspaceReturn(`/plan-runs/${encodeURIComponent(detail.planRun.id)}`);
	const backToTasks = useWorkspaceReturn("/tasks");
	return (
		<div className="flex min-h-full flex-col gap-4 px-3.5 py-6 md:px-6">
			<Link {...backToPlan} className="text-(--color-primary) text-sm hover:underline">
				← Back to plan
			</Link>
			<Link {...backToTasks} className="text-(--color-primary) text-sm">
				All tasks
			</Link>
			<header className="flex flex-wrap items-center gap-3">
				<h1 className="min-w-0 break-words font-semibold text-xl">
					{approved?.title ?? child.title ?? `Task ${child.seq}`}
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
			<p className="wrap-anywhere whitespace-pre-line text-(--color-text-2) text-sm">
				{approved?.description ?? taskCopy(run?.prompt, child.title).description}
			</p>
			<TaskProgress child={child} plan={detail.planRun} />
			<Alert
				className="text-(--color-fg)"
				title={status.group === "attention" ? "Action required" : "Current status"}
				variant={status.group === "attention" ? "warning" : "info"}
			>
				<TaskStatusMessage status={status} />
			</Alert>
			<RetryReview
				key={`${child.planRunId}:${child.seq}:${child.reviewStage}:${child.reviewFailure}`}
				plan={detail.planRun}
				child={child}
			/>
			<p className="text-(--color-text-2) text-sm">
				Task {child.seq} of {detail.children.length}
			</p>
			{status.group === "active" ? <TaskActivity child={child} /> : null}
			<TaskBudgetPanel child={child} />
			{child.failureReason === "deployment_incident" ? (
				<DeploymentIncident planRunId={detail.planRun.id} runId={child.runId} />
			) : null}

			<AttemptHistoryPanel
				key={`attempts:${child.planRunId}:${child.seq}`}
				detail={detail}
				child={child}
			/>
			<TaskHistory key={`history:${child.planRunId}:${child.seq}`} child={child} run={run} />
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
