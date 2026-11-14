/** Evidence emitted only after the deployment workflow, exact SHA and smoke checks pass. */
export interface ProductionVerification {
	checks?: { availability: true; version: true; scenario: true };
	sha: string;
	environment: string;
	verifiedAt: string;
}
