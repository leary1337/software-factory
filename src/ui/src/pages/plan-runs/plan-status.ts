import type { PlanRunChildRow, PlanRunState } from "../../api/types.ts";
import { taskStatus } from "../tasks/task-status.ts";

/** The coordinator lifecycle can stay running while its current task waits for an operator. */
export function planStatus(state: PlanRunState, tasks?: readonly PlanRunChildRow[]) {
	const terminal = {
		succeeded: { label: "Completed", tone: "text-(--color-success)" },
		failed: { label: "Stopped", tone: "text-(--color-danger)" },
		cancelled: { label: "Cancelled", tone: "text-(--color-text-2)" },
	};
	if (state !== "running" && state !== "queued") return terminal[state];
	if (!tasks) return { label: "Status pending", tone: "text-(--color-text-2)" };
	const current = [...tasks]
		.sort((a, b) => a.seq - b.seq)
		.find((task) => task.state !== "merged" && task.state !== "skipped");
	const status = current ? taskStatus(current, { state }) : null;
	if (
		status &&
		(status.group === "attention" || status.phase === "Delivery" || status.group === "active")
	) {
		return {
			label: status.label,
			tone: status.group === "active" ? "text-(--color-info)" : "text-(--color-warning)",
		};
	}
	return { label: state === "queued" ? "Queued" : "Running", tone: "text-(--color-info)" };
}
