import type { ProductionVerification } from "../core/production-verification.ts";
import type { ReviewRepos } from "./review.ts";

export async function loadProductionVerification(
	repos: ReviewRepos,
	runId: string | null,
): Promise<ProductionVerification | null> {
	if (runId === null) return null;
	const events = await repos.events.listByRun(runId);
	for (const event of [...events].reverse()) {
		if (event.kind !== "plan_run.deployment_verified") continue;
		const payload: unknown = event.payloadJson;
		if (typeof payload !== "object" || payload === null) continue;
		if (!("expectedSha" in payload) || typeof payload.expectedSha !== "string") continue;
		if (!("environment" in payload) || typeof payload.environment !== "string") continue;
		return { sha: payload.expectedSha, environment: payload.environment, verifiedAt: event.ts };
	}
	return null;
}
