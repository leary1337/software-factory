import { Link } from "react-router-dom";
import { AttemptHistory } from "./attempt-history.tsx";
import { type TaskItem, taskUrl } from "./task-attempts.ts";
import { TaskCardFrame } from "./task-card-frame.tsx";
import { taskCopy } from "./task-copy.ts";
import { taskStatus } from "./task-status.ts";

export function TaskCard({ task }: { task: TaskItem }) {
	const { child, detail, project } = task.current;
	const approved = detail.approval?.snapshot.tasks.find((task) => task.seq === child.seq);
	const status = taskStatus(child, detail.planRun);
	const run = detail.runs.find((entry) => entry.id === child.runId);
	if (run?.failureReason === "spawn_failed")
		status.detail =
			"The execution environment could not be prepared or started. Open diagnostics for the setup failure.";
	const review = child.reviewSteps?.filter((step) => step.step !== "rework").at(-1)?.summary;
	return (
		<TaskCardFrame
			project={project}
			{...(approved
				? { title: approved.title, description: approved.description }
				: taskCopy(run?.prompt, child.title))}
			status={status}
			href={taskUrl(task.current)}
		>
			{review?.status === "passed" && review.gateVerified && review.reviewedCommit ? (
				<p className="text-(--color-text-2) text-sm">
					Independent review and checks passed for {review.reviewedCommit.slice(0, 8)}.
				</p>
			) : null}
			{task.active.length > 1 ? (
				<p className="text-(--color-warning) text-sm">
					Multiple attempts are active. Open attempt history before starting more work.
				</p>
			) : null}
			{task.blockers
				.filter((attempt) => attempt !== task.current)
				.map((attempt) => (
					<p key={taskUrl(attempt)} className="text-(--color-warning) text-sm">
						<Link className="underline" to={taskUrl(attempt)}>
							Another attempt needs attention:{" "}
							{taskStatus(attempt.child, attempt.detail.planRun).label}
						</Link>
					</p>
				))}
			{task.incidents
				.filter((attempt) => attempt !== task.current)
				.map((attempt) => (
					<p key={taskUrl(attempt)} className="text-(--color-danger) text-sm">
						<Link className="underline" to={taskUrl(attempt)}>
							Production incident in another attempt — inspect its resolution
						</Link>
					</p>
				))}
			<div className="flex flex-wrap gap-4 text-sm">
				<Link
					className="text-(--color-text-2)"
					to={`/projects/${encodeURIComponent(detail.planRun.projectId)}`}
				>
					Project and release
				</Link>
				<Link
					className="text-(--color-text-2)"
					to={`/plan-runs/${encodeURIComponent(detail.planRun.id)}`}
				>
					{detail.planRun.planName ?? "View plan"}
				</Link>
			</div>
			{task.attempts.length > 1 ? (
				<AttemptHistory attempts={task.attempts} selected={task.current} />
			) : null}
		</TaskCardFrame>
	);
}
