/** Evidence emitted only after the deployment workflow, exact SHA and smoke checks pass. */
export interface ProductionVerification {
	checks?: { availability: true; version: true; scenario: true };
	sha: string;
	environment: string;
	verifiedAt: string;
}
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
export function verifiedReleaseChecks(
	payload: unknown,
	ts: string,
): {
	sha: string;
	verifiedAt: string;
	checks: { availability: true; version: true; scenario: true };
} | null {
	const data = record(payload);
	const checks = record(data.verification);
	if (
		!Number.isFinite(Date.parse(ts)) ||
		typeof data.expectedSha !== "string" ||
		!/^[a-f0-9]{40}$/i.test(data.expectedSha)
	)
		return null;
	if (checks.availability !== true || checks.version !== true || checks.scenario !== true)
		return null;
	return {
		sha: data.expectedSha,
		verifiedAt: ts,
		checks: { availability: true, version: true, scenario: true },
	};
}
/** Shared receipt policy for server projection and browser recovery history. */
export function productionVerificationFromEvent(event: {
	kind: string;
	payloadJson: unknown;
	ts: string;
}): ProductionVerification | null {
	if (event.kind !== "plan_run.deployment_verified") return null;
	const proof = verifiedReleaseChecks(event.payloadJson, event.ts);
	const payload = record(event.payloadJson);
	if (!proof || typeof payload.environment !== "string" || !payload.environment.trim()) return null;
	return { ...proof, environment: payload.environment.trim() };
}
