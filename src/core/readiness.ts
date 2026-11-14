export interface ReadinessCheck {
	name: string;
	ok: boolean;
	message: string;
}
export interface ProjectReadiness {
	ready: boolean;
	stale: boolean;
	fingerprint: string;
	checkedAt?: string;
	commit?: string;
	checks: ReadinessCheck[];
	setupPrUrl?: string;
}
export interface ReadinessEvidence {
	fingerprint: string;
	checkedAt: string;
	commit: string;
}

export interface ProjectSetupProposal {
	url: string | null;
	branch: string;
	changed: boolean;
}
