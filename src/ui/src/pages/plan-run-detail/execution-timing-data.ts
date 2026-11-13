import { isTerminalRunState, type RunRow } from "../../api/types.ts";

export function validTimestamp(value: string | null): boolean {
	return value !== null && Number.isFinite(Date.parse(value));
}

/** Missing terminal timestamps are unknown, never an interval that keeps growing. */
export function executionDuration(
	run: Pick<RunRow, "state" | "startedAt" | "endedAt">,
	now: number,
): string {
	if (!validTimestamp(run.startedAt)) return run.state === "queued" ? "Not started" : "Unknown";
	const end =
		run.endedAt === null && !isTerminalRunState(run.state) ? now : Date.parse(run.endedAt ?? "");
	const elapsed = end - Date.parse(run.startedAt ?? "");
	if (!Number.isFinite(elapsed) || elapsed < 0) return "Unknown";
	const seconds = Math.floor(elapsed / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours ? `${hours}h ` : ""}${hours || minutes ? `${minutes}m ` : ""}${seconds % 60}s`;
}
