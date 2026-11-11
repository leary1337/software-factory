import type { PlanRunState } from "@/api/types.ts";

const TONES: Record<PlanRunState, string> = {
	queued: "text-(--color-warning)",
	running: "text-(--color-info)",
	succeeded: "text-(--color-success)",
	failed: "text-(--color-danger)",
	cancelled: "text-(--color-text-2)",
};
const LABELS: Record<PlanRunState, string> = {
	queued: "Queued",
	running: "Running",
	succeeded: "Completed",
	failed: "Stopped",
	cancelled: "Cancelled",
};

export function PlanStateLabel({ state }: { state: PlanRunState }) {
	return <span className={`font-medium text-sm ${TONES[state]}`}>{LABELS[state]}</span>;
}
