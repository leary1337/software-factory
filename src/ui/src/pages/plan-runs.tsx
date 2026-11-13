import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { PlanRunRow, PlanRunStateFilter } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { OperatorOnly, useOperatorHint } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { nextSortState, type SortState } from "@/components/ui/sortable-table-head.tsx";
import { applySort, type Comparator, compareStrings } from "@/hooks/use-client-sort.ts";
import { useListParams } from "@/hooks/use-list-params.ts";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import { WalkRow } from "./plan-runs/walk-row.tsx";

type PlanRunSortKey = "state" | "id" | "planId" | "startedAt";

const STATE_OPTIONS: { label: string; value: "all" | PlanRunStateFilter }[] = [
	{ label: "State: all", value: "all" },
	{ label: "State: unfinished", value: "active" },
	{ label: "State: queued", value: "queued" },
	{ label: "State: in progress", value: "running" },
	{ label: "State: completed", value: "succeeded" },
	{ label: "State: stopped", value: "failed" },
	{ label: "State: cancelled", value: "cancelled" },
];

export function PlanRunsPage() {
	const { params, update } = useListParams();
	const stateFilter =
		STATE_OPTIONS.find((option) => option.value === params.get("state"))?.value ?? "all";
	const projectFilter = params.get("project") ?? "";
	const search = params.get("q") ?? "";

	const planRuns = useQuery({
		queryKey: ["plan-runs", projectFilter, stateFilter],
		queryFn: ({ signal }) =>
			planRunsApi.list(
				{
					...(projectFilter.length > 0 ? { project: projectFilter } : {}),
					...(stateFilter !== "all" ? { state: stateFilter } : {}),
				},
				signal,
			),
		// warren-f566: stream-driven invalidation + slow fallback poll.
		refetchInterval: 45_000,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	const rows = useMemo(() => {
		const all = planRuns.data?.planRuns ?? [];
		if (search.length === 0) return all;
		const q = search.toLowerCase();
		return all.filter((pr) =>
			`${pr.id} ${pr.planId ?? ""} ${pr.planName ?? ""}`.toLowerCase().includes(q),
		);
	}, [planRuns.data, search]);

	const comparators = useMemo<Record<PlanRunSortKey, Comparator<PlanRunRow>>>(
		() => ({
			state: (a, b) => compareStrings(a.state, b.state),
			id: (a, b) => compareStrings(a.id, b.id),
			planId: (a, b) => compareStrings(a.planName ?? a.planId ?? "", b.planName ?? b.planId ?? ""),
			startedAt: (a, b) => compareStrings(a.startedAt ?? "", b.startedAt ?? ""),
		}),
		[],
	);
	const sortKey = params.get("sort");
	const sort: SortState<PlanRunSortKey> = {
		key: sortKey === "state" || sortKey === "planId" ? sortKey : "startedAt",
		direction: params.get("direction") === "asc" ? "asc" : "desc",
	};
	const sorted = applySort(rows, comparators, sort);
	const onSort = (key: PlanRunSortKey) => {
		const next = nextSortState(sort, key, key === "startedAt" ? "desc" : "asc");
		update({ sort: next.key, direction: next.direction });
	};

	const hasFilters = stateFilter !== "all" || projectFilter.length > 0 || search.length > 0;
	const emptyHint = useOperatorHint("Dispatch one from the Dispatch plan page.");
	// Live elapsed (warren-b610): a 1s tick between the 45s refetches,
	// running only while a visible walk is non-terminal.
	const hasLiveWalks = sorted.some((pr) => !isTerminalPlanRunState(pr.state));
	const now = useNow(1000, hasLiveWalks);
	const projectLabel = (pr: PlanRunRow): string =>
		projectIndex.get(pr.projectId) ?? "Project unavailable";

	return (
		<div className="flex min-h-full flex-col px-3.5 py-6 md:px-6">
			<div className="flex shrink-0 flex-wrap items-start gap-4 pb-5">
				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<h1 className="font-semibold text-(--color-text) text-xl leading-6">Plan runs</h1>
					<p className="text-(--color-text-2) text-sm">
						Follow each plan attempt and its task progress.
					</p>
				</div>
				<OperatorOnly>
					<Button asChild>
						<Link to="/dispatch/plan">Start a plan</Link>
					</Button>
				</OperatorOnly>
			</div>

			<div className="flex shrink-0 flex-wrap items-center gap-3 rounded-t-lg border border-(--color-border) bg-(--color-surface) p-3">
				<FilterSelect
					name="State filter"
					value={stateFilter}
					onChange={(value) => update({ state: value === "all" ? null : value })}
					active={stateFilter !== "all"}
				>
					{STATE_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</FilterSelect>
				<FilterSelect
					name="Project filter"
					value={projectFilter}
					onChange={(value) => update({ project: value })}
					active={projectFilter !== ""}
				>
					<option value="">All projects</option>
					{projects.data?.projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.gitUrl}
						</option>
					))}
				</FilterSelect>
				{hasFilters ? (
					<Button
						variant="ghost"
						type="button"
						onClick={() => update({ state: null, project: null, q: null })}
					>
						Clear
					</Button>
				) : null}
				<div className="min-w-0 flex-1" />
				<Input
					aria-label="Search plans"
					type="search"
					value={search}
					onChange={(event) => update({ q: event.target.value })}
					placeholder="Search by plan name or ID"
					className="min-w-0 flex-1 basis-56"
				/>
			</div>

			<div className="min-w-0 shrink-0 rounded-b-lg border border-(--color-border) border-t-0 bg-(--color-surface)">
				{planRuns.isLoading ? (
					<StatusLine>Loading plan runs…</StatusLine>
				) : planRuns.isError && !planRuns.data ? (
					<StatusLine danger>
						Failed to load plan runs: {formatError(planRuns.error)}{" "}
						<Button variant="outline" onClick={() => void planRuns.refetch()}>
							Retry plans
						</Button>
					</StatusLine>
				) : sorted.length === 0 ? (
					<StatusLine>
						No plan runs match this filter.
						{emptyHint !== undefined ? ` ${emptyHint}` : ""}
					</StatusLine>
				) : (
					<>
						{planRuns.isError ? (
							<StatusLine danger>
								Updates unavailable. Showing the last known plans.{" "}
								<Button variant="outline" onClick={() => void planRuns.refetch()}>
									Retry plans
								</Button>
							</StatusLine>
						) : null}
						<HeaderRow sort={sort} onSort={onSort} />
						<div className="divide-y divide-(--color-border)">
							{sorted.map((pr) => (
								<WalkRow key={pr.id} planRun={pr} projectLabel={projectLabel(pr)} now={now} />
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function HeaderRow({
	sort,
	onSort,
}: {
	sort: SortState<PlanRunSortKey>;
	onSort: (key: PlanRunSortKey) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 border-(--color-border) border-b p-3 text-xs">
			<span className="text-(--color-text-2)">Sort by</span>
			{(
				[
					["Plan", "planId"],
					["State", "state"],
					["Started", "startedAt"],
				] as const
			).map(([label, key]) => (
				<Button
					key={key}
					variant="ghost"
					size="sm"
					onClick={() => onSort(key)}
					aria-pressed={sort.key === key}
				>
					{label}
					{sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
				</Button>
			))}
		</div>
	);
}

function FilterSelect({
	name,
	value,
	onChange,
	active,
	children,
}: {
	/** Stable accessible name for the filter control. */
	name: string;
	value: string;
	onChange: (value: string) => void;
	active: boolean;
	children: React.ReactNode;
}) {
	return (
		<SelectInput
			aria-label={name}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={active ? "border-(--color-primary)" : undefined}
		>
			{children}
		</SelectInput>
	);
}

function StatusLine({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
	return (
		<div className={`p-4 text-sm ${danger ? "text-(--color-danger)" : "text-(--color-text-3)"}`}>
			{children}
		</div>
	);
}
