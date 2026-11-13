import type { TaskMetrics } from "../core/task-metrics.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventRow, PlanRunChildRow, RunRow } from "../db/schema.ts";
import { aggregateTaskMetrics, type TaskMetricRun } from "./task-metrics.ts";

const MAX_LINKED_RUNS = 500;

/** Follow persisted coordinator links, never all runs sharing a ticket id. */
function linkedRuns(run: RunRow, events: readonly EventRow[]): string[] {
	const linked = [run.retryOf, run.parentRunId].filter((id): id is string => id !== null);
	for (const event of events) {
		if (typeof event.payloadJson !== "object" || event.payloadJson === null) continue;
		const data = event.payloadJson as Record<string, unknown>;
		const fields: Record<string, string> = {
			"plan_run.review_step": "stepRunId",
			"plan_run.child_retried": "previousRunId",
			"reap.provider_retry_dispatched": "newRunId",
			"run.retry_dispatched": "retryRunId",
		};
		const field = fields[event.kind];
		const id = field ? data[field] : null;
		if (typeof id === "string") linked.push(id);
	}
	return linked;
}

/** Bounded and cycle-safe; absent or cross-project links are explicitly incomplete. */
export async function loadTaskMetrics(
	repos: Pick<Repos, "runs" | "events">,
	projectId: string,
	child: PlanRunChildRow,
	now = Date.now(),
): Promise<TaskMetrics> {
	const pending = child.runId ? [child.runId] : [];
	const seen = new Set<string>();
	const entries: TaskMetricRun[] = [];
	let missing = 0;
	while (pending.length > 0 && seen.size < MAX_LINKED_RUNS) {
		const id = pending.shift();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const run = await repos.runs.get(id);
		if (!run || run.projectId !== projectId) {
			missing += 1;
			continue;
		}
		const events = await repos.events.listByRun(id);
		entries.push({ run, events });
		pending.push(...linkedRuns(run, events).filter((linked) => !seen.has(linked)));
	}
	return aggregateTaskMetrics(
		child,
		entries,
		missing,
		pending.some((id) => !seen.has(id)),
		now,
	);
}
