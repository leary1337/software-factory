import { getProjectDeployOverview, startProjectDeploy } from "../../projects/deploy.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";

export function getProjectDeployHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) =>
		jsonResponse(200, await getProjectDeployOverview(deps, requireParam(ctx, "id")));
}

export function startProjectDeployHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => jsonResponse(202, await startProjectDeploy(deps, requireParam(ctx, "id")));
}
