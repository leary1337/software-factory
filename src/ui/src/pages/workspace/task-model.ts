import type { PlanRunDetailResponse, ProjectRow, RunRow } from "@/api/types.ts";
import { isTerminalRunState } from "@/api/types.ts";
import { formatRunFailureReason } from "@/lib/labels.ts";
import {
	groupTaskAttempts,
	type TaskAttempt,
	type TaskItem,
	taskExecutionId,
} from "../tasks/task-attempts.ts";
import { taskStatus } from "../tasks/task-status.ts";

export const TASK_COLUMNS = [
	"Queued",
	"In progress",
	"Review",
	"Ready for review",
	"Merged",
	"Production",
	"Stopped",
] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];
export interface WorkspaceTask {
	key: string;
	projectId: string | null;
	title: string;
	column: TaskColumn;
	attention: boolean;
	reason: string;
	updatedAt: number;
	plan?: TaskItem;
	currentPlan?: TaskAttempt;
	runs: RunRow[];
	runId: string | null;
}

export function projectName(project: ProjectRow): string {
	return project.gitUrl
		.replace(/^https?:\/\/[^/]+\//, "")
		.replace(/^git@[^:]+:/, "")
		.replace(/\.git$/, "");
}

function planColumn(task: TaskItem): TaskColumn {
	const { child, detail } = task.current;
	if (child.productionVerification) return "Production";
	if (child.prMergedAt || child.state === "merged") return "Merged";
	const status = taskStatus(child, detail.planRun);
	if (status.group === "closed" || status.group === "stopped") return "Stopped";
	if (child.reviewStage === "reviewing") return "Review";
	if (child.reviewStage === "reworking") return "In progress";
	if (child.state === "pr_open") return "Ready for review";
	if (child.state === "pending") return "Queued";
	if (child.state === "failed") return "Stopped";
	return "In progress";
}

function fromPlan(task: TaskItem): WorkspaceTask {
	const { child, detail } = task.current;
	const status = taskStatus(child, detail.planRun);
	return {
		key: task.key,
		projectId: detail.planRun.projectId,
		title: child.title ?? `Задача ${child.seq}`,
		column: planColumn(task),
		attention: status.group === "attention" || task.blockers.length > 0,
		reason: status.detail ?? status.action,
		updatedAt: Date.parse(child.updatedAt || detail.planRun.createdAt),
		plan: task,
		currentPlan: task.current,
		runs: [],
		runId: taskExecutionId(child),
	};
}

function runColumn(run: RunRow): TaskColumn {
	if (run.prMergedAt || run.prState === "merged") return "Merged";
	if (run.state === "queued") return "Queued";
	if (!isTerminalRunState(run.state)) return "In progress";
	if (run.state === "succeeded") return "Ready for review";
	return "Stopped";
}

function rootRun(run: RunRow, byId: ReadonlyMap<string, RunRow>): RunRow {
	const seen = new Set<string>();
	let current = run;
	while (!seen.has(current.id)) {
		seen.add(current.id);
		const parentId = current.parentRunId ?? current.retryOf;
		const parent = parentId ? byId.get(parentId) : undefined;
		if (!parent || parent.projectId !== run.projectId) break;
		current = parent;
	}
	return current;
}

function standaloneTask(key: string, runs: RunRow[]): WorkspaceTask {
	const newest = [...runs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	const run = newest.find((r) => !isTerminalRunState(r.state)) ?? newest[0];
	if (!run) throw new Error("Task requires an execution");
	return {
		key,
		projectId: run.projectId,
		title: run.prompt?.split("\n")[0]?.trim() || "Задача без описания",
		column: runColumn(run),
		attention: run.state === "failed",
		reason:
			(run.failureReason ? formatRunFailureReason(run.failureReason) : null) ??
			(run.prUrl
				? "Открой PR, чтобы проверить результат и Checks."
				: "Результат и история доступны в деталях задачи."),
		updatedAt: Date.parse(run.endedAt ?? run.startedAt ?? "") || run.createdAt || 0,
		runs: newest,
		runId: run.id,
	};
}

function planOwners(planTasks: TaskItem[]): Map<string, string> {
	const owners = new Map<string, string>();
	for (const task of planTasks) {
		for (const { child } of task.attempts) {
			if (child.runId) owners.set(child.runId, task.key);
			for (const step of child.reviewSteps ?? []) owners.set(step.runId, task.key);
		}
	}
	return owners;
}

function applyStandaloneContinuations(
	tasks: Map<string, WorkspaceTask>,
	owners: ReadonlyMap<string, string>,
) {
	for (const task of tasks.values()) {
		const plan = task.plan;
		if (
			!plan ||
			plan.current.detail.planRun.state === "running" ||
			plan.current.detail.planRun.state === "queued"
		)
			continue;
		const mergedAt = Math.max(
			0,
			...plan.attempts
				.filter(({ child }) => child.state === "merged")
				.map(({ child }) => Date.parse(child.prMergedAt ?? child.endedAt ?? "") || 0),
		);
		const newer = task.runs.filter(
			(run) =>
				!owners.has(run.id) &&
				(run.createdAt ?? 0) > Date.parse(plan.current.detail.planRun.createdAt) &&
				!(run.state === "failed" && Date.parse(run.endedAt ?? "") <= mergedAt),
		);
		if (newer.length)
			tasks.set(task.key, { ...standaloneTask(task.key, newer), plan, runs: task.runs });
	}
}

/** Tracker identity and explicit retry/continuation links; titles never determine identity. */
export function buildWorkspaceTasks(
	details: PlanRunDetailResponse[],
	runs: RunRow[],
): WorkspaceTask[] {
	const planTasks = groupTaskAttempts(
		details.flatMap((detail) =>
			detail.children.map((child) => ({ child, detail, project: detail.planRun.projectId })),
		),
	);
	const tasks = new Map(planTasks.map((task) => [task.key, fromPlan(task)]));
	const byId = new Map([...runs, ...details.flatMap((d) => d.runs)].map((run) => [run.id, run]));
	const owners = planOwners(planTasks);
	const standalone = new Map<string, RunRow[]>();
	for (const run of byId.values()) {
		const root = rootRun(run, byId);
		const seedKey = JSON.stringify([run.projectId, run.seedId || root.seedId]);
		const owner =
			owners.get(run.id) ?? owners.get(root.id) ?? (tasks.has(seedKey) ? seedKey : undefined);
		if (owner) {
			tasks.get(owner)?.runs.push(run);
			continue;
		}
		const key =
			run.seedId || root.seedId ? seedKey : JSON.stringify([run.projectId, "run", root.id]);
		const group = standalone.get(key) ?? [];
		group.push(run);
		standalone.set(key, group);
	}
	applyStandaloneContinuations(tasks, owners);
	for (const [key, group] of standalone) tasks.set(key, standaloneTask(key, group));
	return [...tasks.values()]
		.map((task) => withCurrentExecutionTime(task, byId))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

function withCurrentExecutionTime(task: WorkspaceTask, runs: ReadonlyMap<string, RunRow>) {
	if (task.column !== "In progress" && task.column !== "Review") return task;
	const execution = runs.get(task.runId ?? "");
	if (!execution) return task;
	const startedAt = Date.parse(execution.startedAt ?? "") || execution.createdAt || 0;
	return { ...task, updatedAt: Math.max(startedAt, task.updatedAt || 0) };
}

const CURRENT_ORDER: readonly TaskColumn[] = [
	"In progress",
	"Review",
	"Ready for review",
	"Queued",
];

/** The compact overview must keep executing work ahead of a newly queued backlog. */
export function currentProjectTasks(tasks: WorkspaceTask[], projectId: string): WorkspaceTask[] {
	return tasks
		.filter(
			(task) =>
				task.projectId === projectId && !task.attention && CURRENT_ORDER.includes(task.column),
		)
		.sort((a, b) => CURRENT_ORDER.indexOf(a.column) - CURRENT_ORDER.indexOf(b.column));
}
