import type { PlanRunChildRow, PlanRunState } from "../../api/types.ts";

export function planProgressCounts(children: readonly Pick<PlanRunChildRow, "state">[]) {
	return {
		delivered: children.filter((child) => child.state === "merged").length,
		closed: children.filter((child) => child.state === "skipped").length,
		waiting: children.filter((child) => child.state === "pending").length,
		failed: children.filter((child) => child.state === "failed").length,
	};
}

export function planProgressText(
	children: readonly Pick<PlanRunChildRow, "state">[],
	state: PlanRunState = "running",
): string {
	const counts = planProgressCounts(children);
	const pendingLabel = state === "failed" || state === "cancelled" ? "not started" : "waiting";
	return [
		`${counts.delivered} delivered in this attempt`,
		`${counts.closed} previously closed`,
		`${counts.waiting} ${pendingLabel}`,
		...(counts.failed ? [`${counts.failed} failed`] : []),
	].join(" · ");
}
