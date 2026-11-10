/** Delivery and review vocabulary shared by the coordinator, forge and UI. */
export const DEPLOYMENT_STATES = [
	"success",
	"failure",
	"in_progress",
	"inactive",
	"unknown",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];
export const DEPLOYMENT_CURRENT_STATES = ["deployed", "none", "unknown"] as const;
export type DeploymentCurrentState = (typeof DEPLOYMENT_CURRENT_STATES)[number];
export const REVIEW_STAGES = [
	"reviewing",
	"reworking",
	"ready_to_merge",
	"needs_attention",
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];
export const REVIEW_VERDICTS = ["PASS", "CHANGES"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const REVIEW_GATE_RESULTS = ["PASS", "FAIL", "NOT_RUN"] as const;
export type ReviewGateResult = (typeof REVIEW_GATE_RESULTS)[number];
export const REVIEW_DISPLAY_STATUSES = [
	"passed",
	"changes_requested",
	"checks_not_run",
	"error",
	"pending",
] as const;
export type ReviewDisplayStatus = (typeof REVIEW_DISPLAY_STATUSES)[number];
export const REVIEW_STEP_KINDS = ["review", "ui_review", "rework"] as const;
export type ReviewStepKind = (typeof REVIEW_STEP_KINDS)[number];
