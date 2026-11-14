import type { PlanRunChildRow } from "@/api/types.ts";

export function hasVerifiedRelease(
	child: Pick<PlanRunChildRow, "state" | "productionVerification">,
): boolean {
	const proof = child.productionVerification;
	return (
		child.state === "merged" &&
		Boolean(
			proof &&
				proof.checks?.availability === true &&
				proof.checks.version === true &&
				proof.checks.scenario === true &&
				/^[a-f0-9]{40}$/i.test(proof.sha) &&
				proof.environment.trim() &&
				Number.isFinite(Date.parse(proof.verifiedAt)),
		)
	);
}
