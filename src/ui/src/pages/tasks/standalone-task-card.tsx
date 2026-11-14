import { Link } from "react-router-dom";
import { type StandaloneTask, standaloneStatus } from "./standalone-tasks.ts";
import { TaskCardFrame } from "./task-card-frame.tsx";
import { taskCopy } from "./task-copy.ts";

export function StandaloneTaskCard({ task, project }: { task: StandaloneTask; project: string }) {
	return (
		<TaskCardFrame
			project={project}
			{...taskCopy(task.original.prompt)}
			status={standaloneStatus(task.current)}
			href={`/runs/${encodeURIComponent(task.current.id)}?view=task&original=${encodeURIComponent(task.original.id)}`}
		>
			{task.attempts.length > 1 ? (
				<details className="text-sm">
					<summary className="cursor-pointer text-(--color-text-2)">
						Attempt history ({task.attempts.length})
					</summary>
					<ul className="mt-2 space-y-2">
						{task.attempts.map((run, index) => (
							<li key={run.id}>
								<Link className="text-(--color-primary)" to={`/runs/${encodeURIComponent(run.id)}`}>
									Attempt {index + 1} · {standaloneStatus(run).label}
								</Link>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</TaskCardFrame>
	);
}
