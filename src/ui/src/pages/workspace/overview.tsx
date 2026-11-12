import { Link } from "react-router-dom";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { DeployPanel } from "../project-detail.deploy-panel.tsx";
import { WorkspaceTaskCard } from "./task-card.tsx";
import { currentProjectTasks, projectName, type WorkspaceTask } from "./task-model.ts";

export function Overview({
	tasks,
	projects,
	onOpen,
	incomplete,
}: {
	tasks: WorkspaceTask[];
	projects: ProjectRow[];
	onOpen: (task: WorkspaceTask) => void;
	incomplete: boolean;
}) {
	const attention = tasks.filter((task) => task.attention);
	const recent = tasks
		.filter((task) => !task.attention && (task.column === "Merged" || task.column === "Production"))
		.slice(0, 5);
	return (
		<div className="space-y-8">
			<section className="space-y-3" aria-label="Требует тебя">
				<div className="flex items-center gap-3">
					<h2 className="font-semibold text-base">Требует тебя</h2>
					<span className="text-(--color-text-3) text-sm">{attention.length}</span>
				</div>
				{attention.length === 0 ? (
					<div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-5 text-(--color-text-2) text-sm">
						{incomplete
							? "Очередь пока неполная. Обнови данные, чтобы проверить обращения."
							: "Сейчас от тебя ничего не требуется."}
					</div>
				) : (
					<div className="grid gap-3 xl:grid-cols-2">
						{attention.map((task) => (
							<WorkspaceTaskCard
								key={task.key}
								task={task}
								project={projects.filter((p) => p.id === task.projectId).map(projectName)[0]}
								onOpen={() => onOpen(task)}
							/>
						))}
					</div>
				)}
			</section>
			<section className="space-y-4" aria-label="Текущая работа">
				<h2 className="font-semibold text-base">Текущая работа</h2>
				{projects.length === 0 ? (
					<Alert title="Пока нет проектов">
						<Link to="/projects">Подключить проект →</Link>
					</Alert>
				) : null}
				<div className="grid gap-4 xl:grid-cols-2">
					{projects.map((project) => {
						const current = currentProjectTasks(tasks, project.id);
						return (
							<section
								key={project.id}
								className="min-w-0 rounded-xl border border-(--color-border) p-4"
							>
								<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
									<h3 className="min-w-0 break-words font-medium text-sm">
										{projectName(project)}
									</h3>
									<Link
										className="text-(--color-primary) text-sm"
										to={`/kanban?project=${encodeURIComponent(project.id)}`}
									>
										Все задачи →
									</Link>
								</div>
								<div className="space-y-3">
									{current.slice(0, 3).map((task) => (
										<WorkspaceTaskCard key={task.key} task={task} onOpen={() => onOpen(task)} />
									))}
									{current.length === 0 ? (
										<p className="py-3 text-(--color-text-3) text-sm">Нет активной работы.</p>
									) : null}
									{current.length > 3 ? (
										<p className="text-(--color-text-3) text-sm">
											Ещё {current.length - 3} — в Kanban
										</p>
									) : null}
								</div>
							</section>
						);
					})}
				</div>
			</section>
			<OperatorOnly capability="readOperator">
				<section className="space-y-3" aria-label="Production">
					<div className="flex items-center justify-between gap-3">
						<h2 className="font-semibold text-base">Production</h2>
						<Button variant="link" asChild>
							<Link to="/production">Все releases →</Link>
						</Button>
					</div>
					<div className="grid gap-3 xl:grid-cols-2">
						{projects.map((project) => (
							<DeployPanel
								key={project.id}
								projectId={project.id}
								title={projectName(project)}
								compact
							/>
						))}
					</div>
				</section>
			</OperatorOnly>
			<section className="space-y-3" aria-label="Последние результаты">
				<h2 className="font-semibold text-base">Последние результаты</h2>
				{recent.length ? (
					<div className="grid gap-3 xl:grid-cols-2">
						{recent.map((task) => (
							<WorkspaceTaskCard key={task.key} task={task} onOpen={() => onOpen(task)} />
						))}
					</div>
				) : (
					<p className="text-(--color-text-3) text-sm">Пока нет принятых результатов.</p>
				)}
			</section>
		</div>
	);
}
