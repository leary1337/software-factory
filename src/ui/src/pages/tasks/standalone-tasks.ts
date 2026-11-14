import type { PlanRunDetailResponse, RunRow } from "@/api/types.ts";
import type { TaskStatus } from "./task-status.ts";

export interface StandaloneTask {
	key: string;
	original: RunRow;
	current: RunRow;
	attempts: RunRow[];
}

function rootOf(run: RunRow, runs: ReadonlyMap<string, RunRow>): string {
	const visited = new Set<string>();
	let current = run;
	while (!visited.has(current.id)) {
		visited.add(current.id);
		const parentId = current.retryOf || current.parentRunId;
		if (!parentId) return current.id;
		const parent = runs.get(parentId);
		if (!parent || parent.projectId !== run.projectId) return parentId;
		current = parent;
	}
	return [...visited].sort()[0] ?? run.id;
}

const TECHNICAL_AGENTS = new Set([
	"nightwatch",
	"bugwatch",
	"healer",
	"pr-fixer",
	"reviewer",
	"rework",
]);

/** Link retries and review continuations, and exclude work already represented by a plan. */
export function standaloneTasks(
	runs: readonly RunRow[],
	plans: readonly PlanRunDetailResponse[],
): StandaloneTask[] {
	const linked = new Set(plans.flatMap((plan) => plan.runs.map((run) => run.id)));
	const plannedIssues = new Set(
		plans.flatMap((plan) =>
			plan.children.map((child) => `${plan.planRun.projectId}:${child.seedId}`),
		),
	);
	const index = new Map(runs.map((run) => [run.id, run]));
	const groups = new Map<string, RunRow[]>();
	for (const run of index.values()) {
		const root = rootOf(run, index);
		const origin = index.get(root) ?? run;
		if (
			linked.has(run.id) ||
			linked.has(root) ||
			(origin.trigger === "plan-run" && !!origin.seedId) ||
			TECHNICAL_AGENTS.has(origin.agentName) ||
			plannedIssues.has(`${run.projectId}:${run.seedId}`)
		)
			continue;
		const key = `${run.projectId}:${run.seedId || root}`;
		const group = groups.get(key) ?? [];
		group.push(run);
		groups.set(key, group);
	}
	return [...groups].flatMap(([key, group]) => {
		const attempts = [...group].sort(
			(a, b) =>
				(a.createdAt ?? Date.parse(a.startedAt ?? "1970-01-01")) -
				(b.createdAt ?? Date.parse(b.startedAt ?? "1970-01-01")),
		);
		const original = attempts[0];
		const current = attempts.at(-1);
		return original && current ? [{ key, original, current, attempts }] : [];
	});
}

export function standaloneStatus(run: RunRow): TaskStatus {
	if (run.state === "queued")
		return { group: "waiting", label: "Waiting", action: "The task is waiting for an executor." };
	if (run.state === "running")
		return { group: "active", label: "In progress", action: "Work is running on this device." };
	if (run.state === "cancelled")
		return {
			group: "stopped",
			label: "Cancelled",
			action: "This attempt was cancelled. Its history is preserved.",
		};
	if (run.state === "failed")
		return {
			group: "attention",
			label: "Needs attention",
			action: "Open the task to inspect the failure and resume safely.",
			detail:
				run.failureReason === "never_started" || run.failureReason === "spawn_failed"
					? "The execution environment could not start."
					: undefined,
		};
	return {
		group: "history",
		label: run.prMergedAt ? "Merged" : "Implementation finished",
		action: "Review and release are not verified by this execution result.",
	};
}
