import { Link } from "react-router-dom";
import { planProgressText } from "./plan-progress-summary.ts";
import { TaskActivity } from "./task-activity.tsx";
import { type TaskItem, taskUrl } from "./task-attempts.ts";
import { TaskProgress } from "./task-progress.tsx";
import { taskStatus } from "./task-status.ts";

export function TaskCard({ task }: { task: TaskItem }) {
	const { child, detail, project } = task.current;
	const status = taskStatus(child, detail.planRun);
	const run = detail.runs.find((entry) => entry.id === child.runId);
	const latest = child.reviewSteps?.at(-1);
	return (
		<article className="min-w-0 space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
			<div className="flex flex-wrap justify-between gap-2 text-(--color-text-2) text-xs">
				<span className="break-all">{project}</span>
				<span>{status.label}</span>
			</div>
			<h3 className="break-words font-semibold text-base">
				<Link className="hover:underline" to={taskUrl(task.current)}>
					{child.title ?? `Task ${child.seq}`}
				</Link>
			</h3>
			<p className="text-(--color-text-2) text-xs">
				Task {child.seq} of {detail.children.length}
			</p>
			{status.group === "active" ? (
				<p className="text-(--color-text-2) text-xs">{planProgressText(detail.children)}</p>
			) : null}
			<p className="text-(--color-text-2) text-sm">{status.action}</p>
			{status.group === "attention" && latest?.summary?.reason ? (
				<p className="line-clamp-3 break-words text-sm">{latest.summary.reason}</p>
			) : null}
			<TaskProgress child={child} />
			{status.group === "active" ? <TaskActivity child={child} /> : null}
			{task.active.length > 1 ? (
				<div className="space-y-2 text-sm">
					<p className="font-medium text-(--color-warning)">
						{task.active.length} attempts are working on this task.
					</p>
					{task.active
						.filter((attempt) => attempt !== task.current)
						.map((attempt) => (
							<div
								key={taskUrl(attempt)}
								className="space-y-2 border-(--color-border) border-t pt-2"
							>
								<Link className="text-(--color-primary)" to={taskUrl(attempt)}>
									{taskStatus(attempt.child, attempt.detail.planRun).label} ·{" "}
									{attempt.detail.planRun.planName ?? "View plan"}
								</Link>
								<TaskActivity child={attempt.child} />
							</div>
						))}
				</div>
			) : null}
			{task.incidents
				.filter((attempt) => attempt !== task.current)
				.map((attempt) => (
					<p key={taskUrl(attempt)} className="text-(--color-danger) text-sm">
						<Link className="underline" to={taskUrl(attempt)}>
							Production incident in another attempt — inspect its resolution
						</Link>
					</p>
				))}
			{task.blockers
				.filter(
					(attempt) =>
						attempt !== task.current && attempt.child.failureReason !== "deployment_incident",
				)
				.map((attempt) => (
					<p key={taskUrl(attempt)} className="text-(--color-warning) text-sm">
						<Link className="underline" to={taskUrl(attempt)}>
							Another open attempt needs attention:{" "}
							{taskStatus(attempt.child, attempt.detail.planRun).label}
						</Link>
					</p>
				))}
			{child.state === "skipped" && task.delivered ? (
				<Link className="block text-(--color-primary) text-sm" to={taskUrl(task.delivered)}>
					View confirmed delivery in an earlier attempt
				</Link>
			) : null}
			<div className="flex flex-wrap items-center gap-4 text-sm">
				<Link to={taskUrl(task.current)} className="font-medium text-(--color-primary)">
					Open task →
				</Link>
				<Link
					to={`/plan-runs/${encodeURIComponent(detail.planRun.id)}`}
					className="text-(--color-text-2)"
				>
					{detail.planRun.planName ?? "View plan"}
				</Link>
				{run?.prUrl ? (
					<a href={run.prUrl} target="_blank" rel="noreferrer" className="text-(--color-text-2)">
						Pull request ↗
					</a>
				) : null}
			</div>
			{task.attempts.length > 1 ? <TaskAttemptHistory task={task} /> : null}
		</article>
	);
}

function TaskAttemptHistory({ task }: { task: TaskItem }) {
	return (
		<details className="border-(--color-border) border-t pt-3 text-sm">
			<summary className="cursor-pointer font-medium">
				Attempt history ({task.attempts.length})
			</summary>
			<ul className="mt-3 space-y-3">
				{task.attempts.map((attempt) => (
					<li key={taskUrl(attempt)} className="space-y-1">
						<Link className="text-(--color-primary) hover:underline" to={taskUrl(attempt)}>
							{taskStatus(attempt.child, attempt.detail.planRun).label} ·{" "}
							{new Date(attempt.detail.planRun.createdAt).toLocaleString()}
						</Link>
						<p className="break-words text-(--color-text-2) text-xs">
							{attempt.detail.planRun.planName ?? "Plan attempt"}
							{attempt === task.current ? " · Current" : ""}
						</p>
					</li>
				))}
			</ul>
		</details>
	);
}
