/**
 * GitHub REST transport — response readers.
 *
 * Fail-soft body readers shared by every GitHub call (plan pl-d1c9 step 1,
 * docs/design/forge-contract.md §6.1). Reading a response body must never
 * throw: a truncated or non-JSON error body degrades to `null`/`""` and the
 * caller classifies from the status line instead. `truncate` caps user- and
 * GitHub-controlled text before it lands in an error message that may be
 * persisted on a run row.
 */

import type { CheckRun, CheckSummary, PullRequestAutoMergeState } from "../contract.ts";

/** Parse a response body as JSON, returning `null` on any parse failure. */
export async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

/** Read a response body as text, returning `""` on any failure. */
export async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

/** Cap `input` at `max` chars, appending an ellipsis when truncated. */
export function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}

/**
 * Map the REST `auto_merge` field onto the seam's auto-merge state
 * (pl-92a3): a non-null request object means armed, null means unarmed —
 * GitHub sends the field on every pull-request read, null when nothing is
 * armed. `unknown` stays the honest answer of forges that cannot tell; this
 * reader is why the GitHub arm no longer says it.
 */
export function readAutoMergeState(autoMerge: unknown): PullRequestAutoMergeState {
	return autoMerge !== null && autoMerge !== undefined ? "armed" : "unarmed";
}

/** Failure-ish conclusions the CI rollup counts as `failing`. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"action_required",
	"cancelled",
	"startup_failure",
]);

export function parseCheckRun(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== "number") return null;
	const detailsUrl = typeof obj.details_url === "string" ? obj.details_url : null;
	return {
		name: typeof obj.name === "string" ? obj.name : "",
		status: obj.status === "queued" || obj.status === "completed" ? obj.status : "in_progress",
		conclusion: typeof obj.conclusion === "string" ? obj.conclusion : null,
		jobId: String(extractJobId(detailsUrl, obj.id)),
		detailsUrl,
	};
}

/**
 * GitHub Actions check-runs link to `.../actions/runs/<run>/job/<job_id>`;
 * the trailing job id is what the logs endpoint needs. Falls back to the
 * check-run id for third-party CI (same rule as `src/ci-fixer/check-runs.ts`).
 */
function extractJobId(detailsUrl: string | null, fallbackId: number): number {
	if (detailsUrl !== null) {
		const match = /\/job\/(\d+)/.exec(detailsUrl);
		if (match?.[1] !== undefined) {
			const parsed = Number.parseInt(match[1], 10);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return fallbackId;
}

/** Roll a commit's check runs up to the domain's decision input. */
export function rollUp(runs: CheckRun[]): CheckSummary["conclusion"] {
	if (runs.length === 0) return "unknown";
	if (runs.some((r) => r.status !== "completed")) return "pending";
	if (runs.some((r) => r.conclusion !== null && FAILURE_CONCLUSIONS.has(r.conclusion))) {
		return "failing";
	}
	return "passing";
}
