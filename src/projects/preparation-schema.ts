import { isAbsolute } from "node:path";
import { z } from "zod";
import { PREPARATION_RECIPE_KINDS, PREPARATION_TOOL_NAMES } from "../core/wire.ts";

const tool = z
	.object({
		version: z.string().trim().min(1).max(64).optional(),
		executable: z
			.string()
			.trim()
			.refine(isAbsolute, "Tool executable must be an absolute path")
			.optional(),
	})
	.strict();

export const PreparationRecipeSchema = z
	.object({
		recipe: z.enum(PREPARATION_RECIPE_KINDS),
		command: z.string().trim().min(1).max(8192).optional(),
		timeoutMs: z.number().int().positive().max(3_600_000).optional(),
		tools: z.partialRecord(z.enum(PREPARATION_TOOL_NAMES), tool).optional(),
	})
	.strict()
	.refine((value) => value.recipe !== "command" || Boolean(value.command), {
		message: "Command preparation requires a command",
		path: ["command"],
	});
