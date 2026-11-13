/** Structural diff refusals emitted by the automatic-merge policy. */
export const PULL_REQUEST_DIFF_RISKS = [
	"unsupported_file_mode",
	"diff_too_large",
	"binary_diff",
] as const;
export type PullRequestDiffRisk = (typeof PULL_REQUEST_DIFF_RISKS)[number];
