import { useQuery } from "@tanstack/react-query";
import { runsApi } from "@/api/client.ts";
import { isTerminalRunState, type RunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/hooks/use-now.ts";
import { formatTimestamp } from "@/lib/utils.ts";
import { executionDuration, validTimestamp } from "./execution-timing-data.ts";

/** Fetch only visible history rows; reuse the execution detail cache. */
export function HistoryTiming({ runId, label }: { runId: string; label: string }) {
	const query = useQuery({
		queryKey: ["runs", runId],
		queryFn: ({ signal }) => runsApi.get(runId, signal),
		staleTime: 60_000,
		retry: false,
		refetchInterval: (query) =>
			query.state.data && !isTerminalRunState(query.state.data.state) ? 5000 : false,
	});
	return (
		<div className="space-y-1 text-(--color-text-2) text-xs">
			{query.data ? (
				<ExecutionTiming run={query.data} />
			) : query.isLoading ? (
				<p>Loading timing…</p>
			) : null}
			{query.isError ? (
				<div className="flex flex-wrap items-center gap-2 text-(--color-warning)">
					<span>
						{query.data
							? "Timing updates unavailable; last known values shown."
							: "Timing unavailable."}
					</span>
					<Button
						variant="outline"
						size="sm"
						aria-label={`Retry timing for ${label}`}
						onClick={() => void query.refetch()}
					>
						Retry timing
					</Button>
				</div>
			) : null}
		</div>
	);
}

export function ExecutionTiming({ run }: { run: Pick<RunRow, "state" | "startedAt" | "endedAt"> }) {
	const live = !isTerminalRunState(run.state) && validTimestamp(run.startedAt) && !run.endedAt;
	const now = useNow(1000, live);
	return (
		<div className="space-y-1 text-(--color-text-2) text-xs">
			<div className="flex flex-wrap gap-x-4 gap-y-1">
				<span>
					{validTimestamp(run.startedAt) ? (
						<>
							Started{" "}
							<time dateTime={run.startedAt ?? undefined}>{formatTimestamp(run.startedAt)}</time>
						</>
					) : run.state === "queued" ? (
						"Not started"
					) : (
						"Start time unavailable"
					)}
				</span>
				{validTimestamp(run.endedAt) ? (
					<span>
						Ended <time dateTime={run.endedAt ?? undefined}>{formatTimestamp(run.endedAt)}</time>
					</span>
				) : isTerminalRunState(run.state) ? (
					<span>End time unavailable</span>
				) : null}
			</div>
			<p>
				{live ? "Elapsed" : "Duration"}: {executionDuration(run, now)}
				{live ? " · in progress" : ""}
			</p>
		</div>
	);
}
