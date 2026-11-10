/** Whole-task observations. Unknown measurements stay null or carry missing counts. */
export interface TaskMetrics {
	readonly runCount: number;
	readonly missingRunCount: number;
	readonly incomplete: boolean;
	/** Sum of known costs; includes subscription API-equivalent estimates, never a bill. */
	readonly costUsd: number | null;
	readonly costUnknownRuns: number;
	readonly subscriptionEstimateRuns: number;
	/** Sum of complete four-bucket token observations; cached input is counted once. */
	readonly totalTokens: number | null;
	readonly tokenUnknownRuns: number;
	/** Sum of run execution intervals, including running intervals as of this response. */
	readonly activeMs: number | null;
	readonly durationUnknownRuns: number;
	/** Wall time from first dispatch to task termination, or now for an active task. */
	readonly elapsedMs: number | null;
	/** Wall time to completed delivery, including configured production verification. */
	readonly deliveryMs: number | null;
	readonly reviewCount: number;
	readonly uiReviewCount: number;
	readonly reworkCount: number;
	/** Null until a final review result is known; false as soon as rework/CHANGES is observed. */
	readonly firstPass: boolean | null;
	/** Observable operator actions only; manual commits and manual merges are not inferred. */
	readonly steeringCount: number;
	readonly resumeCount: number;
	/** Requests for owner attention, not proof the owner intervened. */
	readonly escalationCount: number;
	/** Factory deployment incidents only; external defects and rollbacks are not observable. */
	readonly postMergeIncidentCount: number;
}
