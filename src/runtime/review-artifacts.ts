import { z } from "zod";
import type { ReviewEvidence, ReviewFinding } from "../core/review-findings.ts";

export const REVIEW_MANIFEST = "warren-review.json";
export const MAX_REVIEW_BYTES = 128 * 1024;

const FindingSchema = z
	.object({
		id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
		title: z.string().min(1).max(1000),
		command: z.string().min(1).max(2000),
		files: z
			.array(
				z
					.object({
						path: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
						contents: z
							.string()
							.min(1)
							.max(32 * 1024),
					})
					.strict(),
			)
			.min(1)
			.max(8),
	})
	.strict();
const FindingsSchema = z.array(FindingSchema).max(32);
const ManifestSchema = z.object({ version: z.literal(1), findings: FindingsSchema }).strict();
const EvidenceSchema = z.object({
	commit: z.string().regex(/^[a-f0-9]{40}$/),
	findings: FindingsSchema,
	results: z
		.array(
			z.object({
				id: z.string(),
				exitCode: z.number().int().nullable(),
				error: z.string().optional(),
				stdout: z.string().optional(),
				stderr: z.string().optional(),
			}),
		)
		.max(32),
});

export function validateFindings(value: unknown): ReviewFinding[] {
	const findings = FindingsSchema.parse(value);
	if (new TextEncoder().encode(JSON.stringify(findings)).length > MAX_REVIEW_BYTES)
		throw new Error("Review artifacts exceed the byte limit");
	if (new Set(findings.map((finding) => finding.id)).size !== findings.length)
		throw new Error("Duplicate review finding id");
	for (const finding of findings) {
		if (new Set(finding.files.map((file) => file.path)).size !== finding.files.length)
			throw new Error("Duplicate review artifact path");
	}
	return findings;
}

export function parseReviewManifest(
	text: string,
	prior: readonly ReviewFinding[],
): ReviewFinding[] {
	const manifest = ManifestSchema.parse(JSON.parse(text));
	return validateFindings([...prior, ...manifest.findings]);
}

export function parseReviewEvidence(value: unknown): ReviewEvidence | null {
	const parsed = EvidenceSchema.safeParse(value);
	if (!parsed.success) return null;
	try {
		validateFindings(parsed.data.findings);
	} catch {
		return null;
	}
	const { findings, results } = parsed.data;
	if (
		results.length !== findings.length ||
		new Set(results.map((result) => result.id)).size !== results.length
	)
		return null;
	if (findings.some((finding) => !results.some((result) => result.id === finding.id))) return null;
	return parsed.data;
}
