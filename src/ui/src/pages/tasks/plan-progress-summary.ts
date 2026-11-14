import type { PlanRunChildRow, PlanRunState } from "../../api/types.ts";
import { hasVerifiedRelease } from "./task-evidence.ts";

export function planProgressCounts(
	children: readonly Pick<PlanRunChildRow, "state" | "productionVerification">[],
) {
	return {
		merged: children.filter((child) => child.state === "merged").length,
		delivered: children.filter(hasVerifiedRelease).length,
		closed: children.filter((child) => child.state === "skipped").length,
		waiting: children.filter((child) => child.state === "pending").length,
		failed: children.filter((child) => child.state === "failed").length,
	};
}

export function planProgressText(
	children: readonly Pick<PlanRunChildRow, "state" | "productionVerification">[],
	state: PlanRunState = "running",
): string {
	const counts = planProgressCounts(children);
	const pendingLabel = state === "failed" || state === "cancelled" ? "not started" : "waiting";
	return [
		`${counts.merged} merged · ${counts.delivered} release verified`,
		`${counts.closed} previously closed`,
		`${counts.waiting} ${pendingLabel}`,
		...(counts.failed ? [`${counts.failed} failed`] : []),
	].join(" · ");
}
