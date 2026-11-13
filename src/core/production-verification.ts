/** Evidence emitted only after the deployment workflow, exact SHA and smoke checks pass. */
export interface ProductionVerification {
	sha: string;
	environment: string;
	verifiedAt: string;
}
