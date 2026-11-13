import { useQueries, useQuery } from "@tanstack/react-query";
import { planRunsApi, projectsApi, runsApi } from "@/api/client.ts";
import type { RunRow } from "@/api/types.ts";
import { buildWorkspaceTasks } from "./task-model.ts";

/** Read the complete scoped history so older executions cannot become duplicate task cards. */
async function loadRuns(project: string, signal: AbortSignal): Promise<RunRow[]> {
	const runs: RunRow[] = [];
	let total = 1;
	while (runs.length < total) {
		const page = await runsApi.list(
			{ project, sort: "started", dir: "asc", limit: 200, offset: runs.length },
			signal,
		);
		runs.push(...page.runs);
		total = page.total;
		if (page.runs.length === 0) break;
	}
	return runs;
}

export function useWorkspaceData(project: string) {
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const plans = useQuery({
		queryKey: ["plan-runs", "workspace", project],
		queryFn: ({ signal }) => planRunsApi.list({ project }, signal),
		refetchInterval: 45_000,
	});
	const runs = useQuery({
		queryKey: ["runs", "workspace", project],
		queryFn: ({ signal }) => loadRuns(project, signal),
		refetchInterval: 45_000,
	});
	const details = useQueries({
		queries: (plans.data?.planRuns ?? []).map((plan) => ({
			queryKey: ["plan-runs", plan.id],
			queryFn: ({ signal }: { signal: AbortSignal }) => planRunsApi.get(plan.id, signal),
			refetchInterval: plan.state === "running" || plan.state === "queued" ? 5_000 : 45_000,
		})),
	});
	const queries = [projects, plans, runs, ...details];
	return {
		projects: projects.data?.projects ?? [],
		tasks: buildWorkspaceTasks(
			details.flatMap((query) => (query.data ? [query.data] : [])),
			runs.data ?? [],
		),
		loading: queries.some((query) => query.isLoading),
		error: queries.find((query) => query.error)?.error,
		refreshing: queries.some((query) => query.isFetching),
		refresh: () => Promise.all(queries.map((query) => query.refetch())),
	};
}
