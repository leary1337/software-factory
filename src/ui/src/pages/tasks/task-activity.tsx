import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { type EventExplorerRow, eventsApi, runsApi } from "@/api/client.ts";
import { isTerminalRunState, type PlanRunChildRow, type RunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/hooks/use-now.ts";
import { summarizeEventPayload } from "../event-explorer-format.ts";

import { taskExecutionId } from "./task-attempts.ts";

export function TaskActivity({ child }: { child: PlanRunChildRow }) {
	const runId = taskExecutionId(child);
	return runId ? (
		<ExecutionActivity key={runId} runId={runId} />
	) : (
		<p className="text-(--color-text-2) text-xs">Waiting for an execution to start.</p>
	);
}

function age(timestamp: string, now: number): string {
	const value = Date.parse(timestamp);
	if (!Number.isFinite(value)) return "unknown";
	const seconds = Math.max(0, Math.floor((now - value) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

function ExecutionActivity({ runId }: { runId: string }) {
	const activity = useQuery({
		queryKey: ["runs", runId, "task-activity"],
		queryFn: async ({ signal }) => {
			const [run, latest, messages] = await Promise.all([
				runsApi.get(runId, signal),
				eventsApi.list({ runId, limit: 1 }, signal),
				eventsApi.list({ runId, kind: "text", limit: 1 }, signal),
			]);
			return { run, event: latest.events[0], message: messages.events[0] };
		},
		refetchInterval: 5000,
	});
	const now = useNow(1000);
	const data = activity.data;
	const isStale = activity.dataUpdatedAt > 0 && now - activity.dataUpdatedAt > 20_000;
	const isUnavailable = activity.isError || isStale || activity.fetchStatus === "paused";
	return (
		<section className="space-y-2 text-sm" aria-label="Current activity">
			{data ? (
				<ActivitySnapshot data={data} now={now} />
			) : !isUnavailable ? (
				<p className="text-(--color-text-2)">Loading current activity…</p>
			) : null}
			{isUnavailable ? (
				<div className="space-y-1 text-(--color-warning)">
					<p>
						Live updates unavailable.{" "}
						{data ? "Showing the last known activity." : "Current activity is unknown."} This does
						not mean the agent has stopped.
					</p>
					<Button variant="outline" size="sm" onClick={() => void activity.refetch()}>
						Retry activity
					</Button>
				</div>
			) : null}
			{data ? (
				<p className="text-(--color-text-2) text-xs">
					Updated {age(new Date(activity.dataUpdatedAt).toISOString(), now)}
				</p>
			) : null}
			<Link
				className="text-(--color-primary) hover:underline"
				to={`/runs/${encodeURIComponent(runId)}`}
			>
				Live log
			</Link>
		</section>
	);
}

function ActivitySnapshot({
	data,
	now,
}: {
	data: { run: RunRow; event: EventExplorerRow | undefined; message: EventExplorerRow | undefined };
	now: number;
}) {
	const finished = isTerminalRunState(data.run.state);
	return (
		<>
			{finished ? (
				<p className="text-(--color-text-2)">
					Execution {data.run.state}. Waiting for the plan to update.
				</p>
			) : null}
			<p className="text-(--color-text-2) text-xs">
				{data.run.startedAt ? `Started ${age(data.run.startedAt, now)}` : "Waiting to start"}
				{data.event ? ` · Last event ${age(data.event.ts, now)}` : " · No events reported yet"}
			</p>
			{data.message ? (
				<p className="wrap-anywhere line-clamp-3">
					<span className="text-(--color-text-2)">
						Agent update ({age(data.message.ts, now)}):{" "}
					</span>
					{summarizeEventPayload(data.message.payload)}
				</p>
			) : (
				<p className="text-(--color-text-2)">No agent update reported yet.</p>
			)}
		</>
	);
}
