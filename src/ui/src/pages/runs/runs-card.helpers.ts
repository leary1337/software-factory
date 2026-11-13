import type { RunRow } from "@/api/types.ts";
import type { InventoryCardTone } from "@/components/ui/inventory-card.tsx";
// Relative, not `@/` — this module is imported by runs-card.helpers.test.ts,
// which runs under the repo-root `bun test`, where the `@/` alias does not
// resolve (see labels.test.ts for the same constraint).
import { humanizeWireValue } from "../../lib/labels.ts";

export interface RunStateCell {
	readonly tone: InventoryCardTone;
	readonly label: string;
}

/** State cell (tone + short word), per the mock's state column. */
export function stateCellOf(row: RunRow): RunStateCell {
	switch (row.state) {
		case "running":
			return { tone: "info", label: "running" };
		case "queued":
			return { tone: "warning", label: "queued" };
		case "succeeded":
			// warren-0993: a succeeded run's PR facts pick the short word —
			// "merged" / "PR open" — otherwise the plain state name. The mock
			// paints PR-open with the primary accent; the card vocabulary's
			// closest reachable tone is info.
			if (row.prMergedAt !== null) return { tone: "success", label: "merged" };
			if (row.prState === "open") return { tone: "info", label: "PR open" };
			return { tone: "success", label: "succeeded" };
		case "failed":
			return { tone: "danger", label: "failed" };
		case "cancelled":
			return { tone: "neutral", label: "cancel" };
	}
}

/** "984" from a PR URL's trailing numeric segment; "" when absent. */
function prNumberOf(prUrl: string | null): string {
	if (prUrl === null) return "";
	const segments = prUrl.split("/").filter((s) => s.length > 0);
	const last = segments[segments.length - 1] ?? "";
	return /^\d+$/.test(last) ? last : "";
}

/** Short prose for a failure reason — subline width, tooltip carries raw. */
function shortFailureReason(reason: string): string {
	if (reason === "push_rejected_policy") return "push blocked";
	return humanizeWireValue(reason).toLowerCase();
}

/**
 * Subline: agent · project · ONE contextual extra, per the mock. The extra
 * is picked by state relevance — PR ref for pr-open, commits for delivered,
 * cap % near budget, stop reason for failed. Cancelled rows carry no stop
 * reason on the wire (`failureReason` is null on cancelled), so they stay
 * at two segments.
 */
export function sublineOf(row: RunRow, projectName: string): string {
	const extras: string[] = [row.agentName, projectName];
	const extra = contextualExtraOf(row);
	if (extra !== null) extras.push(extra);
	return extras.join(" · ");
}

function contextualExtraOf(row: RunRow): string | null {
	if (row.state === "failed" && row.failureReason !== null) {
		return shortFailureReason(row.failureReason);
	}
	if (row.state === "succeeded") {
		const pr = prNumberOf(row.prUrl);
		if (pr !== "") return `PR #${pr}`;
		if (row.commitsAhead !== null && row.commitsAhead > 0) {
			return `${row.commitsAhead} commit${row.commitsAhead === 1 ? "" : "s"}`;
		}
		return null;
	}
	return null;
}
