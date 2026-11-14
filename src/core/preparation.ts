import type { PreparationRecipeKind, PreparationToolName } from "./wire.ts";

export interface PreparationTool {
	version?: string;
	executable?: string;
}

export interface PreparationRecipe {
	recipe: PreparationRecipeKind;
	command?: string;
	timeoutMs?: number;
	tools?: Partial<Record<PreparationToolName, PreparationTool>>;
}
