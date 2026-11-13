import { ValidationError } from "../../core/errors.ts";
import { OPS_WINDOWS, type OpsWindow } from "../../core/wire.ts";
import {
	buildOpsOverview,
	type OpsDelivery,
	type OpsOverview,
	type OpsRunCounts,
} from "../../runs/ops-overview.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";

/** The reduced body a `readPublic`-only caller sees. */
export interface PublicOpsOverview {
	readonly runs: Pick<OpsRunCounts, "byState" | "nonTerminal" | "total">;
	readonly window: OpsWindow;
	readonly delivery: OpsDelivery;
	readonly services: Pick<OpsOverview["services"], "runtime" | "dbReachable" | "lifecycleStream">;
	readonly generatedAt: string;
}

/** Allowlist projection of the operator body for spectators. */
export function toPublicOpsOverview(body: OpsOverview): PublicOpsOverview {
	return {
		runs: pickFields(body.runs, ["byState", "nonTerminal", "total"]),
		window: body.window,
		delivery: pickFields(body.delivery, ["branchesPushed", "prsOpened", "prsMerged"]),
		services: pickFields(body.services, ["runtime", "dbReachable", "lifecycleStream"]),
		generatedAt: body.generatedAt,
	};
}

/** Parse `?window=24h|7d|30d` (default `24h`), rejecting unknown tokens. */
export function parseOpsWindow(ctx: { url: URL }): OpsWindow {
	const raw = ctx.url.searchParams.get("window");
	if (raw === null || raw === "") return "24h";
	if (!(OPS_WINDOWS as readonly string[]).includes(raw)) {
		throw new ValidationError(`?window must be one of ${OPS_WINDOWS.join(", ")}; got '${raw}'`);
	}
	return raw as OpsWindow;
}

export function opsOverviewHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const window = parseOpsWindow(ctx);
		const body = await buildOpsOverview(
			deps.dbAdapter,
			{
				runtime: deps.runtimeProvider.kind,
				lifecycleStream: deps.lifecycleStream !== undefined,
			},
			// deps.now: the frozen-clock seam (ui-visual fixture boot, warren-010b).
			{ window, ...(deps.now !== undefined ? { now: deps.now() } : {}) },
		);
		const projected = isPublicOnly(ctx.actor) ? toPublicOpsOverview(body) : body;
		return jsonResponse(200, projected);
	};
}
