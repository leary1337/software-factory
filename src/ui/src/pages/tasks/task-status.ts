import type { PlanRunChildRow, PlanRunRow } from "@/api/types.ts";
import { formatPlanRunFailureReason } from "../../lib/labels.ts";
import { hasVerifiedRelease } from "./task-evidence.ts";

export type TaskGroup =
	| "attention"
	| "active"
	| "waiting"
	| "complete"
	| "closed"
	| "stopped"
	| "history";

export type TaskPhase = "Implementation" | "Review" | "Delivery" | "Complete";
export interface TaskStatus {
	group: TaskGroup;
	label: string;
	action: string;
	detail?: string;
	paths?: readonly string[];
}

type PlanState = Pick<PlanRunRow, "state">;

export function taskStatus(child: PlanRunChildRow, plan: PlanState) {
	const status = resolveTaskStatus(child, plan);
	return { ...status, phase: status.group === "stopped" ? null : taskPhase(child) };
}

function taskPhase(child: PlanRunChildRow): TaskPhase | null {
	if (child.state === "merged") return hasVerifiedRelease(child) ? "Complete" : "Delivery";
	if (child.state === "skipped" || child.state === "pending") return null;
	if (child.reviewMerge || child.prMergedAt || child.failureReason === "deployment_incident")
		return "Delivery";
	if (child.reviewStage === "ready_to_merge" || (child.state === "pr_open" && !child.reviewStage))
		return "Delivery";
	return child.reviewStage ? "Review" : "Implementation";
}

function resolveTaskStatus(child: PlanRunChildRow, plan: PlanState): TaskStatus {
	const terminal = terminalStatus(child, plan);
	if (terminal) return terminal;
	const merge = mergeStatus(child);
	if (merge) return merge;
	if (child.budget?.awaitingDispatch)
		return {
			group: "attention",
			label: "Budget reached",
			detail: child.budget.reason ?? "The next execution exceeds the task or plan budget.",
			action: child.budget.nextAction ?? "Review the task and plan limits before continuing.",
		};
	if (child.reviewStage === "needs_attention" || child.state === "failed")
		return {
			group: "attention",
			label: "Needs attention",
			detail: failureDetail(child),
			action: "Open the task to inspect the blocker and choose the next step.",
		};
	if (child.reviewStage === "reworking")
		return {
			group: "active",
			label: "Reworking",
			action: "Rework is addressing the review findings.",
		};
	if (child.reviewStage === "reviewing")
		return {
			group: "active",
			label: "Reviewing",
			action: "Independent review and verification are in progress.",
		};
	if (child.state === "pr_open")
		return {
			group: "waiting",
			label: "Awaiting delivery",
			action: "Waiting for pull request merge and delivery verification.",
		};
	if (child.state === "pending")
		return {
			group: "waiting",
			label: "Queued",
			action: "Starts when its dependencies are complete and an executor is available.",
		};
	return {
		group: "active",
		label: "Implementing",
		action: "The agent is implementing and checking the change.",
	};
}

export const TASK_GROUPS: { key: TaskGroup; title: string }[] = [
	{ key: "active", title: "Current work" },
	{ key: "attention", title: "Needs attention" },
	{ key: "waiting", title: "Waiting" },
	{ key: "complete", title: "Completed" },
	{ key: "history", title: "Earlier tasks" },
	{ key: "closed", title: "Previously closed" },
	{ key: "stopped", title: "Stopped attempts" },
];

function mergeStatus(child: PlanRunChildRow): TaskStatus | null {
	const merge = child.reviewMerge;
	if (!merge || merge.kind === "merged" || child.prMergedAt) return null;
	return {
		group: merge.kind === "blocked" ? "attention" : "waiting",
		label: merge.kind === "blocked" ? "Awaiting merge decision" : "Merge retry pending",
		action: merge.nextAction,
		detail: merge.detail,
		paths: merge.paths,
	};
}

function terminalStatus(child: PlanRunChildRow, plan: PlanState): TaskStatus | null {
	if (child.state === "merged")
		return hasVerifiedRelease(child)
			? {
					group: "complete",
					label: "Release verified",
					action: "The published version and user scenario were verified.",
				}
			: {
					group: "waiting",
					label: "Release not verified",
					detail: "Code is merged. Release verification has not been recorded.",
					action: "Open the project to check delivery.",
				};
	if (child.state === "skipped")
		return {
			group: "closed",
			label: "Previously closed",
			action: "Closed in the tracker before dispatch. Delivery is not confirmed by this status.",
		};
	if (child.failureReason === "deployment_incident")
		return {
			group: "attention",
			label: "Production incident",
			action: "Inspect production, repair or roll back, then resume verification.",
		};
	if (plan.state === "cancelled" || (plan.state === "failed" && child.state === "pending"))
		return {
			group: "stopped",
			label: plan.state === "cancelled" ? "Cancelled" : "Not started",
			action: "This attempt stopped. Its history remains available.",
		};
	if (plan.state === "failed")
		return {
			group: "attention",
			label: "Plan stopped",
			detail: failureDetail(child),
			action: "Inspect the plan before resuming work.",
		};
	return null;
}

function failureDetail(child: PlanRunChildRow): string | undefined {
	if (child.failureReason) return formatPlanRunFailureReason(child.failureReason);
	const latest = child.reviewSteps?.at(-1)?.summary;
	return latest && latest.status !== "passed" ? (latest.reason ?? undefined) : undefined;
}
