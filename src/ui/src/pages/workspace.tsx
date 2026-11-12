import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useListParams } from "@/hooks/use-list-params.ts";
import { formatError } from "@/lib/format-error.ts";
import { Kanban } from "./workspace/kanban.tsx";
import { Overview } from "./workspace/overview.tsx";
import { useProjectScope } from "./workspace/project-scope.tsx";
import { TaskPanel } from "./workspace/task-panel.tsx";
import { useWorkspaceData } from "./workspace/use-workspace-data.ts";
import { WorkspaceHeader } from "./workspace/workspace-header.tsx";

export function WorkspacePage({ view }: { view: "Overview" | "Kanban" }) {
	const { project, setProject } = useProjectScope();
	const data = useWorkspaceData(project);
	const { params, update } = useListParams();
	const search = params.get("q") ?? "";
	const tasks = data.tasks.filter((task) =>
		task.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
	);
	const selected = data.tasks.find((task) => task.key === params.get("task"));
	const projects = data.projects.filter((p) => !project || p.id === project);
	const openTask = (task: { key: string }) => update({ task: task.key });
	return (
		<div className="min-h-full space-y-7 px-3.5 py-6 md:px-6">
			<WorkspaceHeader
				title={view}
				description={
					view === "Overview"
						? "Твои решения, текущая работа и результаты по всем проектам."
						: "Одна карточка на задачу — от запуска до Production."
				}
				projects={data.projects}
				project={project}
				onProject={setProject}
			/>
			{data.error ? (
				<Alert variant="danger" title="Не удалось обновить данные">
					{formatError(data.error)}
					<p>Показан последний доступный снимок. Очередь может быть неполной.</p>
					<Button variant="outline" disabled={data.refreshing} onClick={() => void data.refresh()}>
						Повторить
					</Button>
				</Alert>
			) : null}
			{data.loading ? (
				<Spinner label="Загрузка задач" />
			) : view === "Kanban" ? (
				<>
					<Input
						aria-label="Поиск задач"
						placeholder="Поиск задач"
						className="max-w-lg"
						value={search}
						onChange={(e) => update({ q: e.target.value })}
					/>
					<Kanban tasks={tasks} onOpen={openTask} />
				</>
			) : (
				<Overview incomplete={!!data.error} tasks={tasks} projects={projects} onOpen={openTask} />
			)}
			{selected ? (
				<TaskPanel key={selected.key} task={selected} onClose={() => update({ task: null })} />
			) : null}
		</div>
	);
}
