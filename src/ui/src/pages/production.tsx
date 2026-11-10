import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { DeployPanel } from "./project-detail.deploy-panel.tsx";

export function ProductionPage() {
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	return (
		<div className="flex min-h-full flex-col gap-6 px-3.5 py-6 md:px-6">
			<header>
				<h1 className="font-semibold text-xl">Production</h1>
				<p className="mt-2 text-(--color-text-2) text-sm">
					Current releases and delivery status across your projects.
				</p>
			</header>
			{projects.isLoading ? <Spinner label="Loading projects" /> : null}
			{projects.isError ? (
				<Alert variant="danger" title="Could not load production">
					{formatError(projects.error)}{" "}
					<Button variant="outline" onClick={() => void projects.refetch()}>
						Retry
					</Button>
				</Alert>
			) : null}
			{projects.data?.projects.length === 0 ? (
				<Alert title="No projects yet">
					<Link to="/projects">Connect a project to track delivery.</Link>
				</Alert>
			) : null}
			{projects.data?.projects.map((project) => (
				<section key={project.id} className="min-w-0 space-y-3">
					<h2 className="break-all font-semibold">
						<Link to={`/projects/${encodeURIComponent(project.id)}`}>
							{project.gitUrl.replace(/^https:\/\/github.com\//, "")}
						</Link>
					</h2>
					<DeployPanel projectId={project.id} />
				</section>
			))}
		</div>
	);
}
