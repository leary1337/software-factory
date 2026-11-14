import {
	type ProductionVerification,
	productionVerificationFromEvent,
} from "../core/production-verification.ts";
import type { ReviewRepos } from "./review.ts";

export { productionVerificationFromEvent } from "../core/production-verification.ts";

export async function loadProductionVerification(
	repos: ReviewRepos,
	runId: string | null,
): Promise<ProductionVerification | null> {
	if (runId === null) return null;
	const events = await repos.events.listByRun(runId);
	for (const event of [...events].reverse()) {
		const verified = productionVerificationFromEvent(event);
		if (verified) return verified;
	}
	return null;
}
