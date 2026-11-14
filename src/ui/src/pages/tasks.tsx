import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi, runsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useListParams } from "@/hooks/use-list-params.ts";
import { StandaloneTaskCard } from "./tasks/standalone-task-card.tsx";
import { standaloneStatus, standaloneTasks } from "./tasks/standalone-tasks.ts";
import { groupTaskAttempts } from "./tasks/task-attempts.ts";
import { TaskCard } from "./tasks/task-card.tsx";
import { TaskGroupSection } from "./tasks/task-group-section.tsx";
import { TaskListNotices } from "./tasks/task-list-notices.tsx";
import { TASK_GROUPS, taskStatus } from "./tasks/task-status.ts";

export function TasksPage() {
	const { params, update } = useListParams();
	const search = params.get("q") ?? "";
	const projectId = params.get("project") ?? "";
	const requestedLimit = Number(params.get("limit"));
	const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 12 ? requestedLimit : 12;
	const plans = useQuery({
		queryKey: ["plan-runs", "tasks", projectId],
		queryFn: ({ signal }) => planRunsApi.list(projectId ? { project: projectId } : {}, signal),
		refetchInterval: 45_000,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const runs = useInfiniteQuery({
		queryKey: ["runs", "tasks", projectId],
		initialPageParam: 0,
		queryFn: ({ signal, pageParam }) =>
			runsApi.list(
				{
					...(projectId ? { project: projectId } : {}),
					limit: 100,
					offset: pageParam,
					sort: "started",
					dir: "desc",
				},
				signal,
			),
		getNextPageParam: (last, pages) => {
			const count = pages.reduce((sum, page) => sum + page.runs.length, 0);
			return count < last.total ? count : undefined;
		},
		refetchInterval: 45000,
	});
	const ordered = [...(plans.data?.planRuns ?? [])].sort((a, b) => {
		const active = (state: string) => state === "running" || state === "queued";
		return (
			Number(active(b.state)) - Number(active(a.state)) || b.createdAt.localeCompare(a.createdAt)
		);
	});
	const visiblePlans = ordered.filter(
		(plan, index) => index < limit || plan.state === "running" || plan.state === "queued",
	);
	const details = useQueries({
		queries: visiblePlans.map((plan) => ({
			queryKey: ["plan-runs", plan.id],
			queryFn: ({ signal }: { signal: AbortSignal }) => planRunsApi.get(plan.id, signal),
			refetchInterval: plan.state === "running" || plan.state === "queued" ? 5000 : 45_000,
		})),
	});
	const names = new Map(
		(projects.data?.projects ?? []).map((p) => [
			p.id,
			p.gitUrl.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, ""),
		]),
	);
	const tasks = details.flatMap((query) =>
		query.data
			? query.data.children.map((child) => ({
					child,
					detail: query.data,
					project: names.get(query.data.planRun.projectId) ?? "Project unavailable",
				}))
			: [],
	);
	const matched = groupTaskAttempts(tasks).filter((task) =>
		task.attempts.some(({ child, detail, project }) =>
			`${child.title ?? ""} ${project} ${detail.planRun.planName ?? ""}`
				.toLowerCase()
				.includes(search.toLowerCase()),
		),
	);
	const standalone = standaloneTasks(
		runs.data?.pages.flatMap((page) => page.runs) ?? [],
		details.flatMap((query) => (query.data ? [query.data] : [])),
	).filter((task) =>
		`${task.original.prompt ?? ""} ${names.get(task.original.projectId ?? "") ?? ""}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	);
	return (
		<div className="flex min-h-full flex-col gap-6 px-3.5 py-6 md:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="font-semibold text-xl">Tasks</h1>
					<p className="mt-2 text-(--color-text-2) text-sm">
						Follow each task from implementation through review and delivery.
					</p>
				</div>
				<OperatorOnly>
					<Button asChild>
						<Link to="/dispatch/plan">Start a plan</Link>
					</Button>
				</OperatorOnly>
			</header>
			<Input
				aria-label="Search tasks"
				type="search"
				placeholder="Search by task, project or plan"
				value={search}
				onChange={(event) => update({ q: event.target.value })}
			/>
			<TaskListNotices
				plans={plans}
				runs={runs}
				projects={projects}
				details={details}
				isEmpty={matched.length + standalone.length === 0}
				search={search}
			/>
			{TASK_GROUPS.map(({ key, title }) => {
				const rows = matched.filter(
					({ current }) => taskStatus(current.child, current.detail.planRun).group === key,
				);
				const individual = standalone.filter(
					(task) => standaloneStatus(task.current).group === key,
				);
				return rows.length + individual.length ? (
					<TaskGroupSection
						key={key}
						group={key}
						title={title}
						count={rows.length + individual.length}
						searching={!!search}
					>
						<div className="grid gap-3 xl:grid-cols-2">
							{rows.map((row) => (
								<TaskCard key={row.key} task={row} />
							))}
							{individual.map((task) => (
								<StandaloneTaskCard
									key={task.key}
									task={task}
									project={names.get(task.original.projectId ?? "") ?? "Project unavailable"}
								/>
							))}
						</div>
					</TaskGroupSection>
				) : null;
			})}
			{runs.hasNextPage ? (
				<Button
					variant="outline"
					disabled={runs.isFetchingNextPage}
					onClick={() => void runs.fetchNextPage()}
				>
					{runs.isFetchingNextPage ? "Loading task history…" : "Load more task history"}
				</Button>
			) : null}
			{ordered.length > visiblePlans.length ? (
				<div className="space-y-2">
					<p className="text-(--color-text-2) text-sm">
						Showing tasks from {visiblePlans.length} of {ordered.length} plans. All active plans are
						included. Search and attempt history cover loaded plans.
					</p>
					<Button variant="outline" onClick={() => update({ limit: String(limit + 12) })}>
						Load more plans
					</Button>
				</div>
			) : null}
		</div>
	);
}
