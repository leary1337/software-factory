import { z } from "zod";
import type { ReleaseVerification } from "../core/release.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";

export interface WorkflowProofContext {
	deploys: ForgeDeploys;
	ref: RepoRef;
	runId: number;
	startedAt: string;
	now: Date;
	checkedBefore?: string;
}
const ProofSchema = z
	.object({
		schemaVersion: z.literal(1),
		sha: z.string().regex(/^[a-f0-9]{40}$/),
		workflowRunId: z.number().int().positive(),
		checkedAt: z.string().datetime({ offset: true }),
		readOnly: z.literal(true),
		platform: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
		health: z.object({ url: z.string().url(), status: z.literal(200) }).strict(),
		version: z.object({ url: z.string().url(), sha: z.string() }).strict(),
		scenario: z
			.object({ url: z.string().url(), expectedText: z.string(), passed: z.literal(true) })
			.strict(),
	})
	.strict();

/** The workflow reads the protected app with its existing secrets; only non-secret evidence leaves it. */
export async function verifyWorkflowRelease(input: {
	sha: string;
	smokeUrl: string;
	verification: ReleaseVerification;
	workflow: WorkflowProofContext;
}) {
	const { workflow, verification } = input;
	if (!verification.artifactName || !workflow.deploys.readVerificationArtifact)
		throw new Error("Workflow application verification is unavailable");
	const result = await workflow.deploys.readVerificationArtifact(
		workflow.ref,
		workflow.runId,
		verification.artifactName,
	);
	if (!result.ok) throw new Error("Workflow application evidence could not be retrieved");
	const proof = ProofSchema.parse(result.value);
	if (
		proof.sha !== input.sha ||
		proof.platform.sha !== input.sha ||
		proof.version.sha !== input.sha ||
		proof.workflowRunId !== workflow.runId
	)
		throw new Error("Workflow evidence does not identify the released commit and run");
	if (
		proof.health.url !== input.smokeUrl ||
		proof.version.url !== verification.versionUrl ||
		proof.scenario.url !== verification.scenarioUrl ||
		proof.scenario.expectedText !== verification.expectedText
	)
		throw new Error("Workflow evidence does not match the approved application checks");
	const checkedAt = Date.parse(proof.checkedAt);
	if (
		checkedAt < Date.parse(workflow.startedAt) ||
		checkedAt > workflow.now.getTime() + 60_000 ||
		(workflow.checkedBefore !== undefined && checkedAt >= Date.parse(workflow.checkedBefore))
	)
		throw new Error("Workflow application evidence is stale");
	return {
		sha: input.sha,
		availability: true,
		version: true,
		scenario: true,
		workflowRunId: workflow.runId,
		checkedAt: proof.checkedAt,
	};
}
