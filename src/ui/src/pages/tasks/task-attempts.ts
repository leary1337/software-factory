import type { PlanRunChildRow, PlanRunDetailResponse } from "../../api/types.ts";
import { hasVerifiedRelease } from "./task-evidence.ts";
import { taskStatus } from "./task-status.ts";

export interface TaskAttempt {
	child: PlanRunChildRow;
	detail: PlanRunDetailResponse;
	project: string;
}

export interface TaskItem {
	key: string;
	current: TaskAttempt;
	attempts: TaskAttempt[];
	active: TaskAttempt[];
	blockers: TaskAttempt[];
	incidents: TaskAttempt[];
	delivered: TaskAttempt | undefined;
}

function newestFirst(a: TaskAttempt, b: TaskAttempt): number {
	return (
		b.detail.planRun.createdAt.localeCompare(a.detail.planRun.createdAt) ||
		b.detail.planRun.id.localeCompare(a.detail.planRun.id) ||
		a.child.seq - b.child.seq
	);
}

export function isOpenAttempt(attempt: TaskAttempt): boolean {
	const state = attempt.detail.planRun.state;
	return (
		(state === "running" || state === "queued") &&
		attempt.child.state !== "merged" &&
		attempt.child.state !== "skipped"
	);
}

/** A task is a tracker identity within a project; names and plan positions may change. */
export function groupTaskAttempts(rows: readonly TaskAttempt[]): TaskItem[] {
	const groups = new Map<string, TaskAttempt[]>();
	const seen = new Set<string>();
	for (const row of rows) {
		const attemptId = JSON.stringify([row.detail.planRun.id, row.child.seq]);
		if (seen.has(attemptId)) continue;
		seen.add(attemptId);
		const identity = row.child.seedId || `${row.detail.planRun.id}:${row.child.seq}`;
		const key = JSON.stringify([row.detail.planRun.projectId, identity]);
		const attempts = groups.get(key) ?? [];
		attempts.push(row);
		groups.set(key, attempts);
	}
	return [...groups].flatMap(([key, rows]) => {
		const attempts = [...rows].sort(newestFirst);
		const open = attempts.filter(isOpenAttempt);
		const active = open.filter(
			(row) => taskStatus(row.child, row.detail.planRun).group === "active",
		);
		const current = active[0] ?? open[0] ?? attempts[0];
		if (!current) return [];
		return [
			{
				key,
				current,
				attempts,
				active,
				blockers: open.filter(
					(row) => taskStatus(row.child, row.detail.planRun).group === "attention",
				),
				incidents: attempts.filter((row) => row.child.failureReason === "deployment_incident"),
				delivered: attempts.find((row) => hasVerifiedRelease(row.child)),
			},
		];
	});
}

export function taskUrl(attempt: TaskAttempt): string {
	return `/plan-runs/${encodeURIComponent(attempt.detail.planRun.id)}?task=${attempt.child.seq}`;
}

/** The latest review or rework owns the current activity, not the old implementation run. */
export function taskExecutionId(child: PlanRunChildRow): string | null {
	if (!child.reviewStage) return child.runId;
	const latest = child.reviewSteps?.at(-1);
	if (child.reviewStage === "reworking" && latest?.step !== "rework") return null;
	if (child.reviewStage === "reviewing" && latest?.step === "rework") return null;
	return latest?.runId ?? null;
}
