import { Plus } from "lucide-react";
import { useState } from "react";
import type { ProjectRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { NewTask } from "./new-task.tsx";
import { projectName } from "./task-model.ts";

export function WorkspaceHeader({
	title,
	description,
	projects,
	project,
	onProject,
}: {
	title: string;
	description: string;
	projects: ProjectRow[];
	project: string;
	onProject: (id: string) => void;
}) {
	const [creating, setCreating] = useState(false);
	return (
		<>
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-2">
					<h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
					<p className="text-(--color-text-2) text-sm">{description}</p>
				</div>
				<div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
					<SelectInput
						aria-label="Проект"
						className="h-10 min-w-0 flex-1 sm:max-w-64"
						value={project}
						onChange={(e) => onProject(e.target.value)}
					>
						<option value="">Все проекты</option>
						{project && !projects.some((p) => p.id === project) ? (
							<option value={project}>Проект недоступен</option>
						) : null}
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{projectName(p)}
							</option>
						))}
					</SelectInput>
					<OperatorOnly>
						<Button className="h-10" onClick={() => setCreating(true)}>
							<Plus className="mr-2 h-4 w-4" />
							Новая задача
						</Button>
					</OperatorOnly>
				</div>
			</header>
			{creating ? (
				<OperatorOnly>
					<NewTask projectId={project} projects={projects} onClose={() => setCreating(false)} />
				</OperatorOnly>
			) : null}
		</>
	);
}
