import { ValidationError } from "../../core/errors.ts";
import { preparePlanApproval, startApprovedPlan } from "../../plan-runs/approval.ts";
import { PrepareApprovalSchema } from "../../plan-runs/approval-schema.ts";
import { RevisePlanSchema, reviseApprovedPlan } from "../../plan-runs/revisions.ts";
import { assertProjectReady } from "../../projects/readiness.ts";
import { activeToolkitVersion } from "../../toolkit/versions.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { readJsonBody, requireParam } from "./index.ts";
import { readinessDeps } from "./projects.readiness.ts";

export function preparePlanApprovalHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const parsed = PrepareApprovalSchema.safeParse(await readJsonBody(ctx));
		if (!parsed.success) throw new ValidationError(parsed.error.message);
		const readiness = await assertProjectReady(readinessDeps(deps), parsed.data.projectId);
		const approval = await preparePlanApproval(
			{
				readiness,
				repos: deps.repos,
				warrenConfigs: deps.warrenConfigs,
				publishToolkit: async () => ({ version: await activeToolkitVersion() }),
			},
			parsed.data,
		);
		return jsonResponse(201, { approval });
	};
}
export function getPlanApprovalHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) =>
		jsonResponse(200, {
			approval: await deps.repos.planApprovals.require(requireParam(ctx, "id")),
		});
}
export function startPlanApprovalHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const approval = await deps.repos.planApprovals.require(id);
		if (!approval.snapshot.readiness)
			throw new ValidationError(
				"This plan has no checked project readiness evidence; prepare a new approval",
			);
		return jsonResponse(201, await startApprovedPlan(deps.repos, id));
	};
}

export function revisePlanApprovalHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const parsed = RevisePlanSchema.safeParse(await readJsonBody(ctx));
		if (!parsed.success) throw new ValidationError(parsed.error.message);
		return jsonResponse(200, {
			approval: await reviseApprovedPlan(deps.repos, requireParam(ctx, "id"), parsed.data),
		});
	};
}
export function planApprovalHistoryHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) =>
		jsonResponse(200, {
			revisions: await deps.repos.planApprovals.history(requireParam(ctx, "id")),
			effects: await deps.repos.planEffects.list(requireParam(ctx, "id")),
		});
}
