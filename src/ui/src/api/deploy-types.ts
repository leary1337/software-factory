import type { DeploymentCurrentState, DeploymentState } from "../../../core/wire.ts";

export type { DeploymentCurrentState, DeploymentState } from "../../../core/wire.ts";

export interface ProjectDeployRecord {
	sha: string;
	createdAt: string;
	state: DeploymentState;
}

export interface ProjectDeployOverview {
	configured: true;
	workflow: string;
	environment: string;
	branch: string;
	current: ProjectDeployRecord | null;
	currentState: DeploymentCurrentState;
	behind: { count: number; changes: Array<{ sha: string; title: string }> } | null;
	activeRun: { id: number; status: string; url: string } | null;
	history: ProjectDeployRecord[];
	activePlan: { merged: number; total: number } | null;
	error: string | null;
}

export type ProjectDeployResponse = ProjectDeployOverview | { configured: false };
