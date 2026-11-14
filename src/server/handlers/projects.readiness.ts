import { dirname, join } from "node:path";
import { checkProjectReadiness, getProjectReadiness } from "../../projects/readiness.ts";
import { proposeProjectSetup } from "../../projects/setup-pr.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";
export function readinessDeps(deps: ServerDeps) {
	return {
		repos: deps.repos,
		forge: deps.forge,
		directory: join(dirname(deps.projectsConfig.root), "project-readiness"),
		warrenConfigs: deps.warrenConfigs,
		spawn: deps.readinessSpawn ?? deps.spawn,
	};
}
export function projectReadinessHandler(deps: ServerDeps, check = false): RouteHandler {
	return async (ctx) =>
		jsonResponse(
			200,
			await (check ? checkProjectReadiness : getProjectReadiness)(
				readinessDeps(deps),
				requireParam(ctx, "id"),
			),
		);
}
export function projectSetupHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) =>
		jsonResponse(200, await proposeProjectSetup(readinessDeps(deps), requireParam(ctx, "id")));
}
