import { useQuery } from "@tanstack/react-query";
import { runsApi } from "@/api/client.ts";

/** Recent runs used to join judge verdicts to agents, projects and PR state. */

const RUNS_JOIN_LIMIT = 200;

export const RUNS_JOIN_QUERY_KEY = ["telemetry", "runs-join", RUNS_JOIN_LIMIT] as const;

/** Recent runs, newest first, bounded for the join. */
export function useRunsJoin() {
	return useQuery({
		queryKey: RUNS_JOIN_QUERY_KEY,
		queryFn: ({ signal }) => runsApi.list({ limit: RUNS_JOIN_LIMIT }, signal),
	});
}
