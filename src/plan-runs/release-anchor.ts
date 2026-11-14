import type { ReleaseVerification } from "../core/release.ts";
import type { Repos } from "../db/repos/index.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { verifyWorkflowRelease } from "../projects/release-workflow-proof.ts";
import type { DeploymentAttempt } from "./deployment-contract.ts";

export interface VerifiedRelease {
	expectedSha: string;
	verificationPolicy: ReleaseVerification;
	smokeUrl: string;
	smokeTimeoutMs: number;
	anchor?: { workflowRunId: number; checkedAt: string; workflow: string; artifactName: string };
}
function verified(payload: unknown, environment: string): payload is VerifiedRelease {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as Record<string, unknown>;
	const evidence = p.verification as Record<string, unknown> | undefined;
	return (
		p.environment === environment &&
		typeof p.expectedSha === "string" &&
		/^[a-f0-9]{40}$/.test(p.expectedSha) &&
		Boolean(p.verificationPolicy) &&
		typeof p.smokeUrl === "string" &&
		evidence?.availability === true &&
		evidence.version === true &&
		evidence.scenario === true
	);
}
/** Find a durable verified release; a platform-only success is not a rollback anchor. */
export async function previousRelease(
	repos: Pick<Repos, "runs" | "events">,
	projectId: string,
	environment: string,
	before: string,
): Promise<VerifiedRelease | null> {
	let latest: { ts: string; release: VerifiedRelease } | undefined;
	for (let offset = 0; ; offset += 100) {
		const runs = await repos.runs.listByProject(projectId, { offset, limit: 100 });
		const events = await repos.events.listByRunIds(runs.map((run) => run.id));
		const found = events
			.filter(
				(e) =>
					e.kind === "plan_run.deployment_verified" &&
					e.ts <= before &&
					verified(e.payloadJson, environment),
			)
			.sort((a, b) => b.ts.localeCompare(a.ts))[0];
		if (found && (!latest || found.ts > latest.ts))
			latest = { ts: found.ts, release: found.payloadJson as unknown as VerifiedRelease };
		if (runs.length < 100) return latest?.release ?? null;
	}
}

/** An onboarding workflow can establish a baseline before the first factory plan exists. */
export async function workflowReleaseAnchor(
	deploys: ForgeDeploys,
	ref: RepoRef,
	failed: DeploymentAttempt,
	now: Date,
): Promise<VerifiedRelease | null> {
	const verification = failed.verification;
	if (!verification?.artifactName || !deploys.readVerificationArtifact) return null;
	const listed = await deploys.listRuns(ref, failed.workflow, 100);
	if (!listed.ok) throw new Error("Cannot inspect the previous verified workflow release");
	const run = listed.value
		.filter(
			(candidate) =>
				failed.previousRunIds.includes(candidate.id) &&
				candidate.status === "completed" &&
				candidate.conclusion === "success" &&
				Date.parse(candidate.createdAt) < Date.parse(failed.startedAt),
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
	if (!run) return null;
	const sha = /^Factory deploy ([a-f0-9]{40})$/.exec(run.displayTitle ?? "")?.[1];
	if (!sha) throw new Error("Previous workflow does not identify an immutable release");
	const evidence = await verifyWorkflowRelease({
		sha,
		smokeUrl: failed.smokeUrl,
		verification,
		workflow: {
			deploys,
			ref,
			runId: run.id,
			startedAt: run.createdAt,
			now,
			checkedBefore: failed.startedAt,
		},
	});
	return {
		expectedSha: sha,
		verificationPolicy: verification,
		smokeUrl: failed.smokeUrl,
		smokeTimeoutMs: failed.smokeTimeoutMs,
		anchor: {
			workflowRunId: run.id,
			checkedAt: evidence.checkedAt,
			workflow: failed.workflow,
			artifactName: verification.artifactName,
		},
	};
}
