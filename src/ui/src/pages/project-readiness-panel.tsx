import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readinessApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { ProjectReadiness } from "../../../core/readiness.ts";

export function useProjectReadiness(projectId: string) {
	return useQuery({
		queryKey: ["project-readiness", projectId],
		queryFn: ({ signal }) => readinessApi.get(projectId, signal),
	});
}
export function ProjectReadinessPanel({ projectId }: { projectId: string }) {
	const query = useProjectReadiness(projectId);
	const cache = useQueryClient();
	const update = (data: ProjectReadiness) =>
		cache.setQueryData(["project-readiness", projectId], data);
	const check = useMutation({ mutationFn: () => readinessApi.check(projectId), onSuccess: update });
	const setup = useMutation({ mutationFn: () => readinessApi.setup(projectId) });
	const data = query.data;
	return (
		<section
			aria-label="Project readiness"
			className="space-y-3 rounded-xl border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Project readiness</h2>
			{query.isPending ? (
				<Spinner label="Loading project readiness" />
			) : query.isError ? (
				<Alert variant="danger" title="Could not check project readiness">
					{formatError(query.error)}
					<Button variant="outline" onClick={() => void query.refetch()}>
						Retry
					</Button>
				</Alert>
			) : (
				<ReadinessSummary data={data} />
			)}
			{check.isError || setup.isError ? (
				<Alert variant="danger" title="Readiness action failed">
					{formatError(check.error ?? setup.error)}
				</Alert>
			) : null}
			{setup.data?.url ? (
				<a
					href={setup.data.url}
					target="_blank"
					rel="noreferrer"
					className="block text-(--color-primary) text-sm"
				>
					Open setup proposal ↗
				</a>
			) : null}
			<OperatorOnly capability="admin">
				<div className="flex flex-wrap gap-3">
					<Button disabled={check.isPending || setup.isPending} onClick={() => check.mutate()}>
						{check.isPending ? "Checking project…" : "Check project readiness"}
					</Button>
					<Button
						variant="outline"
						disabled={check.isPending || setup.isPending}
						onClick={() => setup.mutate()}
					>
						{setup.isPending ? "Preparing setup proposal…" : "Propose setup changes"}
					</Button>
				</div>
			</OperatorOnly>
			<p className="text-(--color-text-2) text-sm">
				Checks use a disposable checkout and do not deploy the application.
			</p>
		</section>
	);
}

function ReadinessSummary({ data }: { data?: ProjectReadiness }) {
	return (
		<>
			<p className="font-medium text-sm">
				{data?.ready && !data.stale
					? "Ready to start approved plans"
					: data?.stale
						? "Settings or code changed — check again"
						: "Setup needs attention"}
			</p>
			<ul className="space-y-2 text-sm">
				{data?.checks.map((entry) => (
					<li key={entry.name}>
						<strong>
							{entry.ok ? "Passed" : "Needs attention"}: {entry.name}
						</strong>
						<p className="text-(--color-text-2)">{entry.message}</p>
					</li>
				))}
			</ul>
			{data?.setupPrUrl ? (
				<a
					href={data.setupPrUrl}
					target="_blank"
					rel="noreferrer"
					className="text-(--color-primary) text-sm"
				>
					Open setup proposal ↗
				</a>
			) : null}
		</>
	);
}
