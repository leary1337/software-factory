/**
 * Authenticated finalization callbacks shared by runtime implementations.
 * GET serves the registered intent; POST settles its correlated result.
 * Duplicate, stale and unknown results retain idempotent 200 responses.
 * The process-wide coordinator is overridable through server dependencies.
 */

import { sharedFinalizeCoordinator } from "../../../runtime/finalization/coordinator.ts";
import { parseFinalizeResultEnvelope } from "../../../runtime/finalization/wire.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { readJsonBody, requireParam } from "../index.ts";

/**
 * `GET /runs/:id/finalize-intent` — serve the parked finalize intent to the
 * runtime harness, or `{ intent: null }` when none is pending yet (the harness
 * keeps polling). The intent already carries its `attemptId` — the correlation
 * key the harness echoes on its result POST.
 */
export function getRunFinalizeIntentHandler(deps: ServerDeps): RouteHandler {
	const coordinator = deps.finalizeCoordinator ?? sharedFinalizeCoordinator;
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const intent = coordinator.peekIntent(id);
		return jsonResponse(200, { intent: intent ?? null });
	};
}

/**
 * `POST /runs/:id/finalize-result` — intake for the runtime harness's collected
 * `FinalizeResult`. Validates the envelope (a malformed body is a 400 the harness
 * can retry), then hands it to the coordinator keyed by `runId` + `attemptId`.
 * The `outcome` (`accepted` | `duplicate` | `stale` | `unknown`) is echoed so the
 * harness can log it; every case is a 200 because redelivery must be safe.
 */
export function postRunFinalizeResultHandler(deps: ServerDeps): RouteHandler {
	const coordinator = deps.finalizeCoordinator ?? sharedFinalizeCoordinator;
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const body = await readJsonBody(ctx);
		const envelope = parseFinalizeResultEnvelope(body);
		const outcome = coordinator.submit(id, envelope.attemptId, envelope.result);
		return jsonResponse(200, { outcome });
	};
}
