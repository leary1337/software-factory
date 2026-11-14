export const PREPARATION_RECOVERY_STATES = ["repairing", "recovered", "failed", "stopped"] as const;
export type PreparationRecoveryState = (typeof PREPARATION_RECOVERY_STATES)[number];
export const ROLLBACK_RECOVERY_STATES = ["running", "verified", "failed", "released"] as const;
export type RollbackRecoveryState = (typeof ROLLBACK_RECOVERY_STATES)[number];
