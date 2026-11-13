/** Portable regression sources retained independently of the reviewed branch. */
export interface ReviewFinding {
	readonly id: string;
	readonly title: string;
	readonly command: string;
	readonly files: readonly { readonly path: string; readonly contents: string }[];
}

export interface ReviewCheckResult {
	readonly id: string;
	readonly exitCode: number | null;
	readonly error?: string;
	readonly stdout?: string;
	readonly stderr?: string;
}

export interface ReviewEvidence {
	readonly commit: string;
	readonly findings: readonly ReviewFinding[];
	readonly results: readonly ReviewCheckResult[];
}
