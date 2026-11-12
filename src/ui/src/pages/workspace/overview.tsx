import { CircleAlert, FolderKanban, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { DeployPanel } from "../project-detail.deploy-panel.tsx";
import { WorkspaceTaskCard } from "./task-card.tsx";
import { currentProjectTasks, projectName, type WorkspaceTask } from "./task-model.ts";

function OverviewSection({
	title,
	count,
	icon,
	link,
	children,
}: {
	title: string;
	count: number;
	icon: ReactNode;
	link: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className="min-w-0 border border-(--color-border) bg-(--color-surface)"
		>
			<header className="flex flex-wrap items-center gap-2 border-(--color-border) border-b px-4 py-3">
				{icon}
				<h2 className="text-lg">{title}</h2>
				<span className="ml-auto text-(--color-text-2) text-sm">{count}</span>
			</header>
			<div className="space-y-3 p-3">{children}</div>
			<div className="border-(--color-border) border-t px-4 py-2 text-(--color-primary) text-xs">
				{link}
			</div>
		</section>
	);
}

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
		.slice(0, 3);
	const visibleProjects = [...projects]
		.sort((a, b) => {
			const active = (id: string) =>
				tasks.filter(
					(task) => task.projectId === id && ["In progress", "Review"].includes(task.column),
				).length;
			return active(b.id) - active(a.id);
		})
		.slice(0, 3);
	const allTasks = tasks.filter(
		(task) =>
			["Queued", "In progress", "Review", "Ready for review"].includes(task.column) &&
			!task.attention,
	).length;
	return (
		<div className="space-y-4">
			<div className="grid items-start gap-4 lg:grid-cols-3">
				<OverviewSection
					title="Требует тебя"
					count={attention.length}
					icon={<CircleAlert aria-hidden className="h-4 w-4 text-(--color-warning)" />}
					link={<Link to="/kanban?attention=1">Все обращения →</Link>}
				>
					{attention.length === 0 ? (
						<p className="p-1 text-(--color-text-2) text-sm">
							{incomplete
								? "Очередь пока неполная. Обнови данные, чтобы проверить обращения."
								: "Сейчас от тебя ничего не требуется."}
						</p>
					) : (
						attention.slice(0, 2).map((task) => (
							<WorkspaceTaskCard
								key={task.key}
								task={task}
								compact
								project={projects
									.find((project) => project.id === task.projectId)
									?.gitUrl.split("/")
									.at(-1)
									?.replace(/\.git$/, "")}
								onOpen={() => onOpen(task)}
							/>
						))
					)}
					{attention.length > 2 ? (
						<p className="text-(--color-text-2) text-xs">
							Ещё {attention.length - 2} — во всех обращениях
						</p>
					) : null}
				</OverviewSection>
				<OverviewSection
					title="Текущая работа"
					count={allTasks}
					icon={<FolderKanban aria-hidden className="h-4 w-4 text-(--color-primary)" />}
					link={<Link to="/kanban">Все задачи · {projects.length} проектов →</Link>}
				>
					{projects.length === 0 ? (
						<Link className="text-(--color-primary) text-sm" to="/projects">
							Подключить проект →
						</Link>
					) : null}
					{visibleProjects.map((project) => {
						const current = currentProjectTasks(tasks, project.id);
						const limit = projects.length > 1 ? 1 : 3;
						return (
							<section key={project.id} className="space-y-2">
								<div className="flex items-center gap-2 px-1 text-xs">
									<h3
										className="min-w-0 truncate font-medium font-sans"
										title={projectName(project)}
									>
										{projectName(project)}
									</h3>
									<Link
										className="ml-auto shrink-0 text-(--color-primary)"
										to={`/kanban?project=${encodeURIComponent(project.id)}`}
									>
										Все задачи · {current.length} →
									</Link>
								</div>
								{current.slice(0, limit).map((task) => (
									<WorkspaceTaskCard
										compact
										key={task.key}
										task={task}
										onOpen={() => onOpen(task)}
									/>
								))}
								{current.length === 0 ? (
									<p className="px-1 text-(--color-text-2) text-xs">Нет активной работы.</p>
								) : null}
							</section>
						);
					})}
					{projects.length > visibleProjects.length ? (
						<p className="text-(--color-text-2) text-xs">
							Ещё {projects.length - visibleProjects.length} проектов — в Kanban
						</p>
					) : null}
				</OverviewSection>
				<OperatorOnly capability="readOperator">
					<OverviewSection
						title="Production"
						count={projects.length}
						icon={<Rocket aria-hidden className="h-4 w-4 text-(--color-primary)" />}
						link={<Link to="/production">Все releases →</Link>}
					>
						{visibleProjects.map((project) => (
							<DeployPanel
								key={project.id}
								projectId={project.id}
								title={projectName(project)}
								compact
							/>
						))}
						{projects.length === 0 ? (
							<p className="text-(--color-text-2) text-sm">Пока нет подключённых проектов.</p>
						) : null}
						{projects.length > visibleProjects.length ? (
							<p className="text-(--color-text-2) text-xs">
								Ещё {projects.length - visibleProjects.length} проектов — в Production
							</p>
						) : null}
					</OverviewSection>
				</OperatorOnly>
			</div>
			<section className="space-y-2" aria-label="Последние результаты">
				<h2 className="text-base">Последние результаты</h2>
				{recent.length ? (
					<div className="grid gap-3 lg:grid-cols-3">
						{recent.map((task) => (
							<WorkspaceTaskCard compact key={task.key} task={task} onOpen={() => onOpen(task)} />
						))}
					</div>
				) : (
					<p className="text-(--color-text-2) text-sm">Пока нет принятых результатов.</p>
				)}
			</section>
		</div>
	);
}
