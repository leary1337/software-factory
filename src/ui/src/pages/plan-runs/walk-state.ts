import type { PlanRunChildState, PlanRunRow, PlanRunState } from "@/api/types.ts";

import { planProgressText } from "../tasks/plan-progress-summary.ts";

/** `h:mm:ss` / `m:ss` / `Ns` mono elapsed, matching the canvas rows. */
export function formatElapsedMs(ms: number): string {
	if (ms < 0) return "—";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const sec = totalSec % 60;
	const min = Math.floor(totalSec / 60);
	if (min < 60) return `${min}:${String(sec).padStart(2, "0")}`;
	const hr = Math.floor(min / 60);
	return `${hr}:${String(min % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Elapsed between start and end (or now) — `—` before the walk starts.
 *
 * `now` is REQUIRED (warren-b610): a default `new Date()` evaluated per
 * render froze live walks until the 45s refetch; call sites thread a
 * `useNow` tick.
 */
export function planRunElapsed(planRun: PlanRunRow, now: number): string {
	if (planRun.startedAt === null) return "—";
	const start = Date.parse(planRun.startedAt);
	if (Number.isNaN(start)) return "—";
	const end = planRun.endedAt !== null ? Date.parse(planRun.endedAt) : now;
	if (Number.isNaN(end)) return "—";
	return formatElapsedMs(end - start);
}

/** The attempt summary keeps tracker closures separate from confirmed delivery. */
export function childSummary(
	state: PlanRunState,
	children: readonly { state: PlanRunChildState; seq?: number }[],
): string {
	if (children.length === 0) return "No tasks";
	const index = children.findIndex(
		(child) => child.state !== "merged" && child.state !== "skipped",
	);
	const current = children[index];
	const position =
		current && (state === "running" || state === "queued")
			? `Task ${current.seq ?? index + 1} of ${children.length} · `
			: "";
	return `${position}${planProgressText(children, state)}`;
}
