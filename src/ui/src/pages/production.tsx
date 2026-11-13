import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { DeployPanel } from "./project-detail.deploy-panel.tsx";
import { useProjectScope } from "./workspace/project-scope.tsx";
import { projectName } from "./workspace/task-model.ts";
import { WorkspaceHeader } from "./workspace/workspace-header.tsx";

export function ProductionPage() {
	const { project, setProject } = useProjectScope();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const visible = projects.data?.projects.filter((p) => !project || p.id === project) ?? [];
	return (
		<div className="min-h-full space-y-7 px-3.5 py-6 md:px-6">
			<WorkspaceHeader
				title="Production"
				description="Опубликованные версии и следующие releases по проектам."
				projects={projects.data?.projects ?? []}
				project={project}
				onProject={setProject}
			/>
			{projects.isLoading ? <Spinner label="Загрузка проектов" /> : null}
			{projects.isError ? (
				<Alert variant="danger" title="Не удалось загрузить Production">
					{formatError(projects.error)}
					<Button variant="outline" onClick={() => void projects.refetch()}>
						Повторить
					</Button>
				</Alert>
			) : null}
			{!projects.isLoading && !projects.isError && !visible.length ? (
				<Alert title="Нет доступных проектов">
					<Link to="/projects">Открыть проекты →</Link>
				</Alert>
			) : null}
			<div className="grid gap-4 xl:grid-cols-2">
				{visible.map((p) => (
					<DeployPanel key={p.id} projectId={p.id} title={projectName(p)} />
				))}
			</div>
		</div>
	);
}
