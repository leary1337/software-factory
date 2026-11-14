import { z } from "zod";
import { ValidationError } from "../../core/errors.ts";
import { readProjectSettings, updateProjectSettings } from "../../projects/settings.ts";
import { executionOptions } from "../../runtime/adapters/execution-profiles.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { readJsonBody, requireParam } from "./index.ts";

const UpdateSchema = z
	.object({ revision: z.number().int().nonnegative(), patch: z.record(z.string(), z.unknown()) })
	.strict();

export function projectSettingsHandler(deps: ServerDeps, update = false): RouteHandler {
	return async (ctx) => {
		const project = await deps.repos.projects.require(requireParam(ctx, "id"));
		const input = {
			project,
			settings: deps.repos.projectSettings,
			warrenConfigs: deps.warrenConfigs,
		};
		if (!update)
			return jsonResponse(200, {
				...(await readProjectSettings(input)),
				executionOptions: executionOptions(),
			});
		const parsed = UpdateSchema.safeParse(await readJsonBody(ctx));
		if (!parsed.success) throw new ValidationError(parsed.error.message);
		return jsonResponse(200, {
			...(await updateProjectSettings({ ...input, ...parsed.data })),
			executionOptions: executionOptions(),
		});
	};
}
