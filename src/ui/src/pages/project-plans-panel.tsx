import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { ProjectReleaseProof } from "./project-release-proof.tsx";
import { planProgressText } from "./tasks/plan-progress-summary.ts";

export function ProjectPlansPanel({ projectId }: { projectId: string }) {
	const runs = useQuery({
		queryKey: ["plan-runs", "project", projectId],
		queryFn: ({ signal }) => planRunsApi.list({ project: projectId }, signal),
		refetchInterval: 45_000,
	});
	const ready = useQuery({
		queryKey: ["ready-plans", projectId],
		queryFn: ({ signal }) => projectsApi.readyPlans(projectId, signal),
	});
	const rows = runs.data?.planRuns ?? [];
	const details = useQueries({
		queries: rows.map((row) => ({
			queryKey: ["plan-runs", row.id],
			queryFn: ({ signal }: { signal: AbortSignal }) => planRunsApi.get(row.id, signal),
			refetchInterval: 45_000,
		})),
	});
	const started = new Set(rows.map((row) => row.planId));
	const waiting = (ready.data?.plans ?? []).filter((plan) => !started.has(plan.id));
	return (
		<section
			aria-label="Project plans"
			className="space-y-4 rounded-xl border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Plans and releases</h2>
			<ProjectReleaseProof
				projectId={projectId}
				plans={details.flatMap((detail) => (detail.data ? [detail.data] : []))}
			/>
			{runs.isLoading || ready.isLoading ? <Spinner label="Loading project plans" /> : null}
			{runs.isError || ready.isError ? (
				<Alert variant="danger" title="Could not load project plans">
					{formatError(runs.error ?? ready.error)}
					<Button
						variant="outline"
						onClick={() => {
							void runs.refetch();
							void ready.refetch();
						}}
					>
						Retry
					</Button>
				</Alert>
			) : null}
			{!runs.isPending &&
			!ready.isPending &&
			!runs.isError &&
			!ready.isError &&
			rows.length + waiting.length === 0 ? (
				<p className="text-(--color-text-2) text-sm">
					No plans yet. Prepare a plan before starting work.
				</p>
			) : null}
			{waiting.map((plan) => (
				<article key={plan.id} className="space-y-2 border-(--color-border) border-t pt-3">
					<h3 className="font-medium">{plan.name ?? "Approved plan"}</h3>
					<p className="text-(--color-text-2) text-sm">
						Not started · {plan.openChildCount} tasks waiting
					</p>
					<Link
						className="text-(--color-primary) text-sm"
						to="/dispatch/plan"
						state={{ project: projectId, planId: plan.id }}
					>
						Review plan
					</Link>
				</article>
			))}
			{rows.map((plan, index) => {
				const detail = details[index];
				return (
					<article key={plan.id} className="space-y-2 border-(--color-border) border-t pt-3">
						<h3 className="font-medium">
							<Link
								className="text-(--color-primary)"
								to={`/plan-runs/${encodeURIComponent(plan.id)}`}
							>
								{plan.planName ?? "Project plan"}
							</Link>
						</h3>
						<p className="text-(--color-text-2) text-sm">{plan.state}</p>
						{detail?.data ? (
							<p className="text-(--color-text-2) text-sm">
								{planProgressText(detail.data.children, plan.state)}
							</p>
						) : detail?.isError ? (
							<Alert variant="warning" title="Plan progress unavailable">
								{formatError(detail.error)}
							</Alert>
						) : (
							<Spinner label="Loading plan progress" />
						)}
						<Link
							className="text-(--color-primary) text-sm"
							to={`/tasks?project=${encodeURIComponent(projectId)}&planRun=${encodeURIComponent(plan.id)}`}
						>
							View tasks
						</Link>
					</article>
				);
			})}
		</section>
	);
}
