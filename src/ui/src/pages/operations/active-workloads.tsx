import { Link } from "react-router-dom";
import type { ProjectRow, RunRow } from "@/api/types.ts";
import {
	CardFigure,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import {
	activeWorkloads,
	activityLine,
	formatDurationMs,
	phaseElapsedMs,
	refreshedAgeLabel,
	shortRepo,
} from "./operations.helpers.ts";
import { StatePill } from "./state-tone.tsx";

const MAX_ROWS = 8;

export function ActiveWorkloads({
	runs,
	projects,
	now,
	loading,
	refreshedAt,
	total,
}: {
	runs: readonly RunRow[] | undefined;
	projects: readonly ProjectRow[] | undefined;
	now: number;
	loading: boolean;
	/** Epoch ms of the last successful newest-runs fetch (query dataUpdatedAt). */
	refreshedAt: number | undefined;
	/** All-time run count from the same response, for the mobile footer. */
	total: number | undefined;
}) {
	const active = runs !== undefined ? activeWorkloads(runs, MAX_ROWS) : [];
	const running = runs?.filter((r) => r.state === "running").length ?? 0;
	const queued = runs?.filter((r) => r.state === "queued").length ?? 0;
	const windowSummary = `${running} RUNNING · ${queued} QUEUED`;
	const projectIndex = new Map<string, string>();
	for (const p of projects ?? []) projectIndex.set(p.id, shortRepo(p.gitUrl));
	return (
		<div className="flex min-w-0 flex-col md:flex-[1.8]">
			<header className="hidden h-7 shrink-0 items-center pb-1.25 md:flex">
				<h2 className="font-semibold text-(--color-text-2) text-xs leading-4.5">
					Active workloads
				</h2>
				<span className="flex-1" />
				<span className="font-mono text-(--color-text-3) text-xs leading-4">{windowSummary}</span>
			</header>
			<div className="flex flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
				<div className="flex items-center gap-2 border-(--color-border) border-b bg-(--color-thead) px-3 py-2.5 md:hidden">
					<h2 className="font-semibold text-(--color-text) text-xs leading-4">Active workloads</h2>
					<span className="flex-1" />
					<span className="font-mono text-(--color-text-3) text-xs leading-4">{windowSummary}</span>
				</div>
				{active.length === 0 ? (
					<p className="px-3 py-3 font-mono text-(--color-text-3) text-xs leading-4">
						{loading ? (
							"loading active workloads…"
						) : (
							<>
								0 active
								<span
									className="mx-1.5 inline-block h-1.5 w-1.5 rounded-full bg-(--color-text-3)"
									aria-hidden
								/>
								idle
							</>
						)}
					</p>
				) : (
					<InventoryCardList>
						{active.map((run) => (
							<ActiveWorkloadCard
								key={run.id}
								run={run}
								projectLabel={
									run.projectId === null
										? "orphaned"
										: (projectIndex.get(run.projectId) ?? run.projectId)
								}
								now={now}
							/>
						))}
					</InventoryCardList>
				)}
				<div className="flex items-center border-(--color-border) border-t px-3 py-2.25 md:hidden">
					<span className="font-mono text-(--color-text-3) text-xs leading-4">
						UPDATED {refreshedAgeLabel(refreshedAt === undefined ? undefined : now - refreshedAt)}
					</span>
					<span className="flex-1" />
					<Link
						to="/runs"
						className="font-medium text-(--color-primary) text-xs leading-4 hover:underline"
					>
						{total === undefined ? "View all runs →" : `View all ${total} runs →`}
					</Link>
				</div>
				<div className="hidden md:block">
					<div className="flex h-[31px] shrink-0 items-center gap-2.5 border-(--color-border-strong) border-b bg-(--color-thead) px-2.5">
						<span className="w-[82px] shrink-0 font-mono font-semibold text-(--color-text-3) text-xs tracking-[0.05em]">
							STATE
						</span>
						<span className="w-[112px] shrink-0 font-mono font-semibold text-(--color-text-3) text-xs tracking-[0.05em]">
							RUN
						</span>
						<span className="w-[76px] shrink-0 font-mono font-semibold text-(--color-text-3) text-xs tracking-[0.05em]">
							AGENT
						</span>
						<span className="w-[96px] shrink-0 font-mono font-semibold text-(--color-text-3) text-xs tracking-[0.05em]">
							PROJECT
						</span>
						<span className="min-w-0 flex-1 font-mono font-semibold text-(--color-text-3) text-xs tracking-[0.05em]">
							ACTIVITY
						</span>
						<span className="w-[48px] shrink-0 text-right font-mono font-semibold text-(--color-text-3) text-xs tracking-[0.05em]">
							ELAPSED
						</span>
					</div>
					{active.map((run) => (
						<Link
							key={run.id}
							to={`/runs/${run.id}`}
							className="flex h-[38px] items-center gap-2.5 border-(--color-border) border-b px-2.5 last:border-b-0 hover:bg-(--color-surface-hover)"
						>
							<span className="w-[82px] shrink-0">
								<StatePill state={run.state} />
							</span>
							<span className="w-[112px] shrink-0 truncate font-mono text-(--color-text) text-xs leading-4">
								{run.id}
							</span>
							<span className="w-[76px] shrink-0 truncate text-(--color-text-2) text-xs leading-4.5">
								{run.agentName}
							</span>
							<span className="w-[96px] shrink-0 truncate text-(--color-text-3) text-xs leading-4.5">
								{run.projectId === null
									? "orphaned"
									: (projectIndex.get(run.projectId) ?? run.projectId)}
							</span>
							<span className="min-w-0 flex-1 truncate text-(--color-text-2) text-xs leading-4.5">
								{run.state === "queued" ? "awaiting admission" : activityLine(run.prompt)}
							</span>
							<span className="w-[48px] shrink-0 text-right font-mono text-(--color-text-2) text-xs leading-4">
								{formatDurationMs(phaseElapsedMs(run, now))}
							</span>
						</Link>
					))}
					<div className="flex h-[38px] shrink-0 items-center gap-3 border-(--color-border) border-t px-2.5">
						<span className="font-mono text-(--color-text-3) text-xs leading-4">
							FROM THE NEWEST RUNS
						</span>
						<span className="flex-1" />
						<Link to="/runs" className="text-(--color-primary) text-xs leading-4.5 hover:underline">
							View all runs →
						</Link>
					</div>
				</div>
			</div>
		</div>
	);
}

function ActiveWorkloadCard({
	run,
	projectLabel,
	now,
}: {
	run: RunRow;
	projectLabel: string;
	now: number;
}) {
	const tone = run.state === "running" ? "info" : "warning";
	return (
		<InventoryRowCard
			tone={tone}
			title={run.id}
			titleTo={`/runs/${run.id}`}
			subline={
				run.state === "queued"
					? `${run.agentName} · ${projectLabel} · awaiting admission`
					: `${run.agentName} · ${projectLabel}`
			}
			figures={<CardFigure value={formatDurationMs(phaseElapsedMs(run, now))} />}
			meta={run.state === "queued" ? undefined : activityLine(run.prompt)}
		/>
	);
}
