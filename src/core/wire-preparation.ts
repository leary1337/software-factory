/** Project preparation recipes and executable vocabulary shared by API and runtime. */
export const PREPARATION_RECIPE_KINDS = [
	"auto",
	"command",
	"javascript",
	"python-uv",
	"go",
] as const;
export type PreparationRecipeKind = (typeof PREPARATION_RECIPE_KINDS)[number];
export const PREPARATION_TOOL_NAMES = [
	"node",
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"python",
	"uv",
	"go",
] as const;
export type PreparationToolName = (typeof PREPARATION_TOOL_NAMES)[number];
