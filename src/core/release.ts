import type { RollbackCompatibility } from "./wire.ts";
/** Read-only application checks fixed in the approved plan. */
export interface ReleaseVerification {
	artifactName?: string;
	versionUrl: string;
	shaField?: string;
	scenarioUrl: string;
	expectedText: string;
}
export interface RollbackPolicy {
	workflow: string;
	shaInput: string;
	compatibility: RollbackCompatibility;
	reason: string;
}
export interface ProjectDeploymentSettings {
	workflow?: string;
	environment?: string;
	autoDeploy?: boolean;
	shaInput?: string;
	smokeUrl?: string;
	timeoutMs?: number;
	smokeTimeoutMs?: number;
	verification?: ReleaseVerification;
	rollback?: RollbackPolicy;
}
