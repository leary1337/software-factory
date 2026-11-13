/** Admission limits for the complete task chain and its containing plan. */
export interface PlanRunBudgetLimits {
	readonly maxRuns?: number;
	readonly maxActiveMs?: number;
}

export interface PlanRunBudgetConfig {
	readonly task?: PlanRunBudgetLimits;
	readonly plan?: PlanRunBudgetLimits;
}

export interface PlanRunBudgetUsage {
	readonly runs: number;
	readonly activeMs: number;
	readonly unknownDurationRuns: number;
	readonly incomplete: boolean;
}

/** A gate on the next dispatch, not a live subscription quota or kill switch. */
export interface PlanRunBudgetSummary {
	readonly limits: PlanRunBudgetConfig;
	readonly task: PlanRunBudgetUsage;
	readonly plan: PlanRunBudgetUsage;
	readonly blocked: boolean;
	/** True only after the coordinator actually refused a dispatch. */
	readonly awaitingDispatch: boolean;
	readonly reason: string | null;
	readonly nextAction: string | null;
}
