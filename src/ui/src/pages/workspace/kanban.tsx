import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { cn } from "@/lib/utils.ts";
import { WorkspaceTaskCard } from "./task-card.tsx";
import { TASK_COLUMNS, type WorkspaceTask } from "./task-model.ts";

function Column({
	title,
	tasks,
	onOpen,
	selected,
}: {
	title: string;
	tasks: WorkspaceTask[];
	selected: boolean;
	onOpen: (task: WorkspaceTask) => void;
}) {
	const [limit, setLimit] = useState(30);
	return (
		<section
			className={cn(
				"w-full shrink-0 rounded-xl bg-(--color-surface-raised)/40 p-3 md:block md:w-72",
				!selected && "hidden",
			)}
			aria-label={title}
		>
			<h2 className="mb-4 flex justify-between gap-3 font-medium text-sm">
				{title}
				<span className="text-(--color-text-3)">{tasks.length}</span>
			</h2>
			<div className="space-y-3">
				{tasks.slice(0, limit).map((task) => (
					<WorkspaceTaskCard key={task.key} task={task} onOpen={() => onOpen(task)} />
				))}
				{tasks.length === 0 ? (
					<p className="py-5 text-(--color-text-3) text-sm">Здесь пока нет задач</p>
				) : null}
				{tasks.length > limit ? (
					<Button variant="outline" onClick={() => setLimit(limit + 30)}>
						Показать ещё
					</Button>
				) : null}
			</div>
		</section>
	);
}
export function Kanban({
	tasks,
	onOpen,
}: {
	tasks: WorkspaceTask[];
	onOpen: (task: WorkspaceTask) => void;
}) {
	const [column, setColumn] = useState("In progress");
	const merged = tasks.filter((task) => task.column === "Merged").length;
	return (
		<div className="space-y-4">
			{merged > 0 ? (
				<p className="rounded-lg border border-(--color-border) p-4 text-sm">
					Merged: {merged}. Проверь состав следующего Release в{" "}
					<Link className="text-(--color-primary) underline" to="/production">
						Production →
					</Link>
				</p>
			) : null}
			<SelectInput
				aria-label="Колонка Kanban"
				className="w-full md:hidden"
				value={column}
				onChange={(e) => setColumn(e.target.value)}
			>
				{TASK_COLUMNS.map((name) => (
					<option key={name}>{name}</option>
				))}
			</SelectInput>
			<section
				className="flex items-start gap-3 overflow-x-auto pb-4"
				aria-label="Kanban"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling for the Kanban columns.
				tabIndex={0}
			>
				{TASK_COLUMNS.map((name) => (
					<Column
						key={name}
						title={name}
						selected={column === name}
						tasks={tasks.filter((t) => t.column === name)}
						onOpen={onOpen}
					/>
				))}
			</section>
		</div>
	);
}
