import type { ReviewMergeProblem } from "../core/review-merge.ts";
import type { ForgeError } from "../forge/contract.ts";
import type { AutoMergeDecision } from "../runs/reap/auto-merge-policy.ts";

export function blockedMerge(
	reason: string,
	detail: string,
	nextAction: string,
): ReviewMergeProblem {
	return { kind: "blocked", reason, detail, nextAction };
}

/** Never persist transport details, which can contain credential-bearing URLs. */
export function mergeForgeProblem(error: ForgeError): ReviewMergeProblem {
	const retryable =
		error.kind === "network" ||
		error.kind === "rate_limited" ||
		(error.kind === "http_error" && error.status !== undefined && error.status >= 500);
	return {
		kind: retryable ? "retry" : "blocked",
		reason: error.kind,
		detail: retryable
			? "The forge is temporarily unavailable or rate limited."
			: `The forge refused automatic merge (${error.kind}).`,
		nextAction: retryable
			? "Wait for the bounded retry; inspect forge availability if it persists."
			: "Inspect pull request checks, branch protections and the factory token's permissions.",
	};
}

export function policyMergeProblem(
	decision: Extract<AutoMergeDecision, { decision: "skip" }>,
): ReviewMergeProblem {
	return {
		...blockedMerge(
			decision.reason,
			`The project's automatic merge policy refused this change (${decision.reason}).`,
			decision.reason === "off"
				? "Merge manually, or explicitly configure pr.autoMerge on the default branch."
				: "Inspect the named files and policy; merge manually only after reviewing the change.",
		),
		...(decision.paths ? { paths: decision.paths } : {}),
	};
}
