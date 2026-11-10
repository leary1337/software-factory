import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { PlanRunChildRow, PlanRunDetailResponse } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { TaskProgress } from "./tasks/task-progress.tsx";
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
	const details = useQueries({
		queries: ordered.slice(0, limit).map((plan) => ({
			queryKey: ["plan-runs", plan.id],
			queryFn: ({ signal }: { signal: AbortSignal }) => planRunsApi.get(plan.id, signal),
			refetchInterval: 15_000,
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
	const matched = tasks.filter(({ child, detail, project }) =>
		`${child.title ?? ""} ${project} ${detail.planRun.planName ?? ""}`
			.toLowerCase()
			.includes(search.toLowerCase()),
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
					This list is incomplete.{" "}
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
			details.every((query) => !query.isLoading) &&
			matched.length === 0 ? (
				<Alert title="No tasks to show">
					{search
						? "No loaded tasks match your search."
						: "Start a plan to track its tasks here. Individual technical runs remain available under More."}
				</Alert>
			) : null}
			{TASK_GROUPS.map(({ key, title }) => {
				const rows = matched.filter(
					({ child, detail }) => taskStatus(child, detail.planRun).group === key,
				);
				return rows.length ? (
					<section key={key} aria-label={title} className="space-y-3">
						<h2 className="font-semibold text-base">
							{title} <span className="text-(--color-text-2)">({rows.length})</span>
						</h2>
						<div className="grid gap-3 xl:grid-cols-2">
							{rows.map((row) => (
								<TaskCard key={`${row.detail.planRun.id}-${row.child.seq}`} {...row} />
							))}
						</div>
					</section>
				) : null;
			})}
			{ordered.length > limit ? (
				<div className="space-y-2">
					<p className="text-(--color-text-2) text-sm">
						Showing tasks from {Math.min(limit, ordered.length)} of {ordered.length} plans, with
						active plans first. Search covers loaded tasks.
					</p>
					<Button variant="outline" onClick={() => setLimit(limit + 12)}>
						Load more plans
					</Button>
				</div>
			) : null}
		</div>
	);
}

function TaskCard({
	child,
	detail,
	project,
}: {
	child: PlanRunChildRow;
	detail: PlanRunDetailResponse;
	project: string;
}) {
	const status = taskStatus(child, detail.planRun);
	const run = detail.runs.find((entry) => entry.id === child.runId);
	const latest = child.reviewSteps?.at(-1);
	const url = `/plan-runs/${encodeURIComponent(detail.planRun.id)}?task=${child.seq}`;
	return (
		<article className="min-w-0 space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
			<div className="flex flex-wrap justify-between gap-2 text-(--color-text-2) text-xs">
				<span className="break-all">{project}</span>
				<span>{status.label}</span>
			</div>
			<h3 className="break-words font-semibold text-base">
				<Link className="hover:underline" to={url}>
					{child.title ?? `Task ${child.seq + 1}`}
				</Link>
			</h3>
			<p className="text-(--color-text-2) text-sm">{status.action}</p>
			{status.group === "attention" && latest?.summary?.reason ? (
				<p className="line-clamp-3 break-words text-sm">{latest.summary.reason}</p>
			) : null}
			<TaskProgress child={child} />
			<div className="flex flex-wrap items-center gap-4 text-sm">
				<Link to={url} className="font-medium text-(--color-primary)">
					Open task →
				</Link>
				<Link
					to={`/plan-runs/${encodeURIComponent(detail.planRun.id)}`}
					className="text-(--color-text-2)"
				>
					{detail.planRun.planName ?? "View plan"}
				</Link>
				{run?.prUrl ? (
					<a href={run.prUrl} target="_blank" rel="noreferrer" className="text-(--color-text-2)">
						Pull request ↗
					</a>
				) : null}
			</div>
		</article>
	);
}
