import type { PlanRunChildRow, PlanRunState } from "@/api/types.ts";
import { planStatus } from "./plan-status.ts";

export function PlanStateLabel({
	state,
	tasks,
}: {
	state: PlanRunState;
	tasks?: readonly PlanRunChildRow[];
}) {
	const status = planStatus(state, tasks);
	return <span className={`font-medium text-sm ${status.tone}`}>{status.label}</span>;
}
