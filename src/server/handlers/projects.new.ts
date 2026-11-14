import { dirname, join } from "node:path";
import { z } from "zod";
import { ValidationError } from "../../core/errors.ts";
import { createNewProject, previewNewProject } from "../../projects/new-project.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { readJsonBody } from "./index.ts";
import { readinessDeps } from "./projects.readiness.ts";

const RequestSchema = z
	.object({
		owner: z.string(),
		name: z.string(),
		template: z.literal("go-react"),
		settings: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export function previewNewProjectHandler(_deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const result = RequestSchema.safeParse(await readJsonBody(ctx));
		if (!result.success) throw new ValidationError(result.error.message);
		return jsonResponse(200, previewNewProject(result.data));
	};
}
export function createNewProjectHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const result = z
			.object({ request: RequestSchema, confirmation: z.string().min(1) })
			.strict()
			.safeParse(await readJsonBody(ctx));
		if (!result.success) throw new ValidationError(result.error.message);
		return jsonResponse(
			201,
			await createNewProject(
				{
					...readinessDeps(deps),
					projectsConfig: deps.projectsConfig,
					creationDirectory: join(dirname(deps.projectsConfig.root), "new-projects"),
				},
				result.data.request,
				result.data.confirmation,
			),
		);
	};
}
