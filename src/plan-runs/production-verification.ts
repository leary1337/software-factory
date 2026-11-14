import { z } from "zod";
import type { ProductionVerification } from "../core/production-verification.ts";
import type { ReviewRepos } from "./review.ts";

const VerifiedReceipt = z.object({
	expectedSha: z.string().regex(/^[a-f0-9]{40}$/i),
	environment: z.string().trim().min(1),
	verification: z.object({
		availability: z.literal(true),
		version: z.literal(true),
		scenario: z.literal(true),
	}),
});

export function productionVerificationFromEvent(event: {
	kind: string;
	payloadJson: unknown;
	ts: string;
}): ProductionVerification | null {
	if (event.kind !== "plan_run.deployment_verified") return null;
	const parsed = VerifiedReceipt.safeParse(event.payloadJson);
	if (!parsed.success || !Number.isFinite(Date.parse(event.ts))) return null;
	return {
		sha: parsed.data.expectedSha,
		environment: parsed.data.environment,
		verifiedAt: event.ts,
		checks: parsed.data.verification,
	};
}

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
