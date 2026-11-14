import type { ReleaseVerification, RollbackPolicy } from "../core/release.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow, PlanRunRow, RunRow } from "../db/schema.ts";
import type { Forge } from "../forge/contract.ts";
import type { DeploymentAdmission } from "../projects/deployment-admission.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { CoordinatorEmitFn } from "./coordinator.ts";
export type DeploymentDecision =
	| { readonly kind: "passed" | "waiting" }
	| { readonly kind: "incident"; readonly reason: string }
	| { readonly kind: "repair"; readonly reason: string; readonly restoredSha: string };
export interface DeploymentInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly run: RunRow;
	readonly prUrl: string;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
}
export type CoordinatorDeploymentFn = (input: DeploymentInput) => Promise<DeploymentDecision>;
export type ProjectDeploymentBlocker = (plan: PlanRunRow) => Promise<string | null>;
export interface DeploymentGateDeps {
	readonly repos: Pick<
		Repos,
		| "projects"
		| "planRuns"
		| "events"
		| "projectSettings"
		| "planApprovals"
		| "planEffects"
		| "runs"
	>;
	readonly forge: Forge;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly fetch?: typeof fetch;
	readonly deploymentAdmission?: DeploymentAdmission;
}
export interface DeploymentAttempt {
	readonly verification?: ReleaseVerification;
	readonly rollback?: RollbackPolicy;
	readonly expectedSha: string;
	readonly shaInput: string;
	readonly branch: string;
	readonly workflow: string;
	readonly environment: string;
	readonly smokeUrl: string;
	readonly timeoutMs: number;
	readonly smokeTimeoutMs: number;
	readonly startedAt: string;
	readonly previousRunIds: readonly number[];
}
