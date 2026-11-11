import type { PlanRunChildState, PlanRunRow, PlanRunState, RunRow } from "@/api/types.ts";

import { planProgressText } from "../tasks/plan-progress-summary.ts";

/**
 * Direction C walk-inventory state helpers (warren-23b2 / pl-7e38 step
 * 6). Colour mappings use only token variables so the dark and light
 * themes both render; the vocabulary itself (`PlanRunState`,
 * `PlanRunChildState`) is re-exported from `src/core/wire.ts`.
 */

/** State dot + label colour for the STATE cell. */
export const PLAN_RUN_STATE_COLOR: Record<PlanRunState, string> = {
	queued: "var(--color-warning)",
	running: "var(--color-info)",
	succeeded: "var(--color-success)",
	failed: "var(--color-danger)",
	cancelled: "var(--color-neutral)",
};

/**
 * Child-square colour per `PlanRunChildState` (the canvas walk-inventory
 * squares): merged green, in-flight blue, pr_open amber (gated on the
 * merge gate), failed red, skipped neutral, pending unfilled rail.
 */
export const CHILD_SQUARE_COLOR: Record<PlanRunChildState, string> = {
	pending: "var(--color-border-strong)",
	dispatched: "var(--color-info)",
	running: "var(--color-info)",
	pr_open: "var(--color-warning)",
	merged: "var(--color-success)",
	failed: "var(--color-danger)",
	skipped: "var(--color-neutral)",
};

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

/**
 * Aggregate cost across a plan-run's child runs (warren-2235 / pl-b0c0
 * step 5). Mirrors RunsRepo.aggregate's NULL-aware rollup: `sum` adds
 * non-null `costUsd` only, `priced` counts those rows, `total` is the
 * full child-run count. Ghost runs whose cost was never recorded land
 * in `total - priced`.
 */
export function summarizeCost(runs: readonly RunRow[]): {
	sum: number;
	priced: number;
	total: number;
} {
	let sum = 0;
	let priced = 0;
	for (const r of runs) {
		if (r.costUsd !== null) {
			sum += r.costUsd;
			priced += 1;
		}
	}
	return { sum, priced, total: runs.length };
}
