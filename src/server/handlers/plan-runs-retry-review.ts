import { ValidationError } from "../../core/errors.ts";
import { buildDefaultPlanRunEmit } from "../../plan-runs/index.ts";
import { retryPlanRunReview } from "../../plan-runs/retry-review.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";

export function retryPlanRunReviewHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const seq = Number(requireParam(ctx, "seq"));
		if (!Number.isSafeInteger(seq) || seq < 1) throw new ValidationError("Invalid task number.");
		const result = await retryPlanRunReview({
			planRunId: requireParam(ctx, "id"),
			seq,
			repos: deps.repos,
			emit: buildDefaultPlanRunEmit(deps.repos, deps.now),
		});
		return jsonResponse(200, result);
	};
}
