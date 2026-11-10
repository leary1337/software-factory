import type { ReviewMergeDisposition } from "./wire.ts";

/** A merge refusal keeps its reason and recovery action separate from the code verdict. */
export interface ReviewMergeProblem {
	readonly kind: Exclude<ReviewMergeDisposition, "merged">;
	readonly reason: string;
	readonly detail: string;
	readonly nextAction: string;
	readonly paths?: readonly string[];
}

export type ReviewMergeResult = { readonly kind: "merged" } | ReviewMergeProblem;

/** Event payloads are persisted JSON; reject malformed or historical values. */
export function readReviewMergeResult(value: unknown): ReviewMergeResult | null {
	if (typeof value !== "object" || value === null) return null;
	const result = value as Record<string, unknown>;
	if (result.kind === "merged") return { kind: "merged" };
	if (
		(result.kind !== "blocked" && result.kind !== "retry") ||
		typeof result.reason !== "string" ||
		typeof result.detail !== "string" ||
		typeof result.nextAction !== "string"
	)
		return null;
	const paths = result.paths;
	if (paths !== undefined && (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")))
		return null;
	return {
		kind: result.kind,
		reason: result.reason,
		detail: result.detail,
		nextAction: result.nextAction,
		...(paths === undefined ? {} : { paths }),
	};
}
