import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { groupTaskAttempts } from "./tasks/task-attempts.ts";
import { TaskCard } from "./tasks/task-card.tsx";
import { TASK_GROUPS, taskStatus } from "./tasks/task-status.ts";

export function TasksPage() {
	const [search, setSearch] = useState("");
	const [limit, setLimit] = useState(12);
	const plans = useQuery({
		queryKey: ["plan-runs", "tasks"],
		queryFn: ({ signal }) => planRunsApi.list({}, signal),
		refetchInterval: 45_000,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
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
	const failed = details.filter((query) => query.isError);
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
				onChange={(event) => setSearch(event.target.value)}
			/>
			{plans.isLoading || details.some((query) => query.isLoading) ? (
				<Spinner label="Loading tasks" />
			) : null}
			{plans.isError ? (
				<Alert variant="danger" title="Could not load tasks">
					{formatError(plans.error)}{" "}
					<Button variant="outline" onClick={() => void plans.refetch()}>
						Retry
					</Button>
				</Alert>
			) : null}
			{projects.isError ? (
				<Alert variant="warning" title="Project names unavailable">
					Task results remain visible.{" "}
					<Button variant="outline" onClick={() => void projects.refetch()}>
						Retry project names
					</Button>
				</Alert>
			) : null}
			{failed.length > 0 ? (
				<Alert variant="danger" title="Some tasks could not be loaded">
					Some task states may be missing or out of date. Last known tasks remain visible.{" "}
					<Button
						variant="outline"
						onClick={() => {
							for (const query of failed) void query.refetch();
						}}
					>
						Retry missing tasks
					</Button>
				</Alert>
			) : null}
			{!plans.isLoading &&
			!plans.isError &&
			details.every((query) => !query.isLoading && !query.isError) &&
			matched.length === 0 ? (
				<Alert title="No tasks to show">
					{search
						? "No loaded tasks match your search."
						: "Start a plan to track its tasks here. Individual technical runs remain available under More."}
				</Alert>
			) : null}
			{TASK_GROUPS.map(({ key, title }) => {
				const rows = matched.filter(
					({ current }) => taskStatus(current.child, current.detail.planRun).group === key,
				);
				return rows.length ? (
					<section key={key} aria-label={title} className="space-y-3">
						<h2 className="font-semibold text-base">
							{title} <span className="text-(--color-text-2)">({rows.length})</span>
						</h2>
						<div className="grid gap-3 xl:grid-cols-2">
							{rows.map((row) => (
								<TaskCard key={row.key} task={row} />
							))}
						</div>
					</section>
				) : null;
			})}
			{ordered.length > visiblePlans.length ? (
				<div className="space-y-2">
					<p className="text-(--color-text-2) text-sm">
						Showing tasks from {visiblePlans.length} of {ordered.length} plans. All active plans are
						included. Search and attempt history cover loaded plans.
					</p>
					<Button variant="outline" onClick={() => setLimit(limit + 12)}>
						Load more plans
					</Button>
				</div>
			) : null}
		</div>
	);
}
