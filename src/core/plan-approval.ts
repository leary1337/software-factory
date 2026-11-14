import type { ExecutionProfiles } from "./execution-profiles.ts";
import type { ReadinessEvidence } from "./readiness.ts";

export const PLAN_PERMISSION_KINDS = ["access", "destructive_migration", "factory_rules"] as const;
export type PlanPermissionKind = (typeof PLAN_PERMISSION_KINDS)[number];
export interface PlanPermission {
	kind: PlanPermissionKind;
	paths: string[];
	reason: string;
}
export interface ApprovedTask {
	revision?: number;
	seq: number;
	id: string;
	title: string;
	description: string;
	acceptance: string[];
	dependsOn: number[];
	releaseAfter: boolean;
	permissions: PlanPermission[];
	initialStatus: "open" | "closed";
}
export interface TaskBudgetLimits {
	repairs: number;
	reworks: number;
	runMs: number;
	activeMs: number;
	externalWaitMs: number;
}
export interface ApprovedPlanSnapshot {
	readiness?: ReadinessEvidence;
	version: 1;
	requestDigest?: string;
	taskSource: "internal" | "tracker";
	projectId: string;
	title: string;
	tasks: ApprovedTask[];
	profiles: ExecutionProfiles;
	toolkitVersion: string;
	settings: Record<string, unknown>;
	agents: Record<string, unknown>;
	budgets: TaskBudgetLimits;
	permissions: PlanPermission[];
	baseBranch: string;
	agentName: string;
	promptTemplate?: string;
}
export interface PlanApproval {
	id: string;
	commandKey: string;
	digest: string;
	snapshot: ApprovedPlanSnapshot;
	revision: number;
	supersedesId: string | null;
	planRunId: string | null;
	decision: string;
	createdAt: string;
}
export interface PreparePlanApproval {
	commandKey: string;
	projectId: string;
	title: string;
	tasks: Array<
		Partial<Pick<ApprovedTask, "id" | "dependsOn" | "releaseAfter" | "permissions">> &
			Pick<ApprovedTask, "title" | "description" | "acceptance">
	>;
	permissions?: PlanPermission[];
}
export const PLAN_EFFECT_STATES = ["intended", "unknown", "confirmed", "rejected"] as const;
export type PlanEffectState = (typeof PLAN_EFFECT_STATES)[number];
export const PLAN_EFFECT_KINDS = ["dispatch", "pr", "merge", "deploy"] as const;
export type PlanEffectKind = (typeof PLAN_EFFECT_KINDS)[number];

export const TASK_ATTEMPT_KINDS = [
	"implementation",
	"review",
	"rework",
	"repair",
	"external_wait",
] as const;
export type TaskAttemptKind = (typeof TASK_ATTEMPT_KINDS)[number];

export interface RevisePlanApproval {
	commandKey: string;
	expectedRevision: number;
	decision: string;
	tasks: Array<PreparePlanApproval["tasks"][number] & { seq: number }>;
	permissions?: PlanPermission[];
	settings?: Record<string, unknown>;
}
export interface PlanEffect {
	identity: string;
	planRunId: string;
	seq: number;
	kind: PlanEffectKind;
	state: PlanEffectState;
	target: string;
	result: Record<string, unknown> | null;
	reason: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface PlanApprovalHistory {
	revisions: PlanApproval[];
	effects: PlanEffect[];
}
