import type { PlanRunChildRow, PlanRunRow } from "@/api/types.ts";

export type TaskGroup = "attention" | "active" | "waiting" | "complete" | "closed" | "stopped";

interface TaskStatus {
	group: TaskGroup;
	label: string;
	action: string;
}

export function taskStatus(child: PlanRunChildRow, plan: PlanRunRow): TaskStatus {
	const terminal = terminalStatus(child, plan);
	if (terminal) return terminal;
	const merge = mergeStatus(child);
	if (merge) return merge;
	if (child.budget?.awaitingDispatch)
		return {
			group: "attention",
			label: "Budget reached",
			action: child.budget.nextAction ?? "Review the task and plan limits before continuing.",
		};
	if (child.reviewStage === "needs_attention" || child.state === "failed")
		return {
			group: "attention",
			label: "Needs attention",
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
			action:
				"Review is complete or awaiting attention; open the task for the latest delivery result.",
		};
	if (child.state === "pending")
		return {
			group: "waiting",
			label: "Queued",
			action: "Starts when the preceding task has been delivered.",
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
	{ key: "closed", title: "Previously closed" },
	{ key: "stopped", title: "Stopped attempts" },
];

function mergeStatus(child: PlanRunChildRow): TaskStatus | null {
	const merge = child.reviewMerge;
	if (!merge || merge.kind === "merged" || child.prMergedAt) return null;
	return {
		group: merge.kind === "blocked" ? "attention" : "waiting",
		label: merge.kind === "blocked" ? "Merge needs attention" : "Merge retry pending",
		action: merge.nextAction,
	};
}

function terminalStatus(child: PlanRunChildRow, plan: PlanRunRow): TaskStatus | null {
	if (child.state === "merged")
		return { group: "complete", label: "Completed", action: "The change has been delivered." };
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
			action: "Inspect the plan before resuming work.",
		};
	return null;
}
