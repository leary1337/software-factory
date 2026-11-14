/** Structural diff refusals emitted by the automatic-merge policy. */
export const PULL_REQUEST_DIFF_RISKS = [
	"unsupported_file_mode",
	"diff_too_large",
	"binary_diff",
] as const;
export type PullRequestDiffRisk = (typeof PULL_REQUEST_DIFF_RISKS)[number];

export const AUTO_MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type AutoMergeMethod = (typeof AUTO_MERGE_METHODS)[number];
export const MERGE_VERIFICATION_MODES = ["forge", "warren"] as const;
export type MergeVerificationMode = (typeof MERGE_VERIFICATION_MODES)[number];
export interface ProjectMergeSettings {
	autoMerge?: {
		method: AutoMergeMethod;
		verification?: MergeVerificationMode;
		requiredChecks?: string[];
		protectedPaths?: string[];
		reviewedPaths?: string[];
	};
}
