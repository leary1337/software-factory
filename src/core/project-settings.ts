import type { ExecutionOption, ExecutionProfiles } from "./execution-profiles.ts";
import type { TaskBudgetLimits } from "./plan-approval.ts";
import type { PreparationRecipe } from "./preparation.ts";
import type { ProjectDeploymentSettings } from "./release.ts";
import type { ProjectMergeSettings } from "./wire-merge.ts";

export interface ProjectSettings {
	pr?: ProjectMergeSettings;
	executionProfiles?: ExecutionProfiles;
	memoryEnabled?: boolean;
	taskBudgets?: Partial<TaskBudgetLimits>;
	preparation?: PreparationRecipe;
	deploy?: ProjectDeploymentSettings;
	qualityGate?: string;
	[key: string]: unknown;
}

export interface ProjectSettingsResponse {
	revision: number;
	overrides: ProjectSettings;
	effective: ProjectSettings & { executionProfiles: ExecutionProfiles };
	executionOptions: ExecutionOption[];
	errors: readonly { message: string }[];
}

export interface ProjectSettingsUpdate {
	revision: number;
	patch: ProjectSettings;
}
