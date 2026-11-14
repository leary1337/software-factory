import { formatError } from "../core/errors.ts";
import type { ReleaseVerification } from "../core/release.ts";
import type { Repos } from "../db/repos/index.ts";
import type { ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { loadDeploymentHistory } from "../projects/deploy.ts";
import { DEFAULT_DEPLOYMENT_ADMISSION } from "../projects/deployment-admission.ts";
import { validateDeploymentWorkflow } from "../projects/deployment-workflow.ts";
import { verifyRelease } from "../projects/release-verification.ts";
import type {
	DeploymentAttempt,
	DeploymentDecision,
	DeploymentGateDeps,
	DeploymentInput,
} from "./deployment-contract.ts";
import { reconcileEffect } from "./effects.ts";

interface VerifiedRelease {
	expectedSha: string;
	verificationPolicy: ReleaseVerification;
	smokeUrl: string;
	smokeTimeoutMs: number;
}
interface RollbackAttempt extends VerifiedRelease {
	workflow: string;
	shaInput: string;
	branch: string;
	environment: string;
	startedAt: string;
	previousRunIds: number[];
	timeoutMs: number;
	reason: string;
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
async function previousRelease(
	repos: Pick<Repos, "runs" | "events">,
	projectId: string,
	environment: string,
): Promise<VerifiedRelease | null> {
	let latest: { ts: string; release: VerifiedRelease } | undefined;
	for (let offset = 0; ; offset += 100) {
		const runs = await repos.runs.listByProject(projectId, { offset, limit: 100 });
		const events = await repos.events.listByRunIds(runs.map((run) => run.id));
		const found = events
			.filter(
				(e) => e.kind === "plan_run.deployment_verified" && verified(e.payloadJson, environment),
			)
			.sort((a, b) => b.ts.localeCompare(a.ts))[0];
		if (found && (!latest || found.ts > latest.ts))
			latest = { ts: found.ts, release: found.payloadJson as unknown as VerifiedRelease };
		if (runs.length < 100) return latest?.release ?? null;
	}
}
async function prepare(
	deps: DeploymentGateDeps,
	input: DeploymentInput,
	failed: DeploymentAttempt,
	reason: string,
	deploys: ForgeDeploys,
	ref: RepoRef,
): Promise<RollbackAttempt> {
	const policy = failed.rollback;
	if (policy?.compatibility !== "application-only")
		throw new Error(
			"Rollback is not approved as compatible with current data; owner intervention required",
		);
	const previous = await previousRelease(deps.repos, input.planRun.projectId, failed.environment);
	if (!previous)
		throw new Error("No previously verified application version is available for rollback");
	if (previous.expectedSha === failed.expectedSha)
		throw new Error("The previous verified release is the failing version");
	const workflow = await deploys.readWorkflow(ref, policy.workflow, failed.branch);
	if (!workflow.ok || !validateDeploymentWorkflow(workflow.value, policy.shaInput))
		throw new Error("Rollback workflow does not pin the approved application commit");
	const runs = await deploys.listRuns(ref, policy.workflow, 100);
	if (!runs.ok || runs.value.some((run) => run.status !== "completed"))
		throw new Error("Cannot establish that deployment workflows have stopped before rollback");
	const attempt = {
		...previous,
		workflow: policy.workflow,
		shaInput: policy.shaInput,
		branch: failed.branch,
		environment: failed.environment,
		startedAt: input.now().toISOString(),
		previousRunIds: runs.value.map((run) => run.id),
		timeoutMs: failed.timeoutMs,
		reason,
	};
	await input.emit(input.run.id, "plan_run.rollback_attempt", {
		...attempt,
		compatibility: policy,
	});
	return attempt;
}
async function dispatch(
	deps: DeploymentGateDeps,
	input: DeploymentInput,
	attempt: RollbackAttempt,
	deploys: ForgeDeploys,
	ref: RepoRef,
) {
	const outcome = await reconcileEffect(deps.repos, {
		identity: `${input.planRun.id}:${input.child.seq}:deploy:rollback:${attempt.expectedSha}`,
		planRunId: input.planRun.id,
		seq: input.child.seq,
		kind: "deploy",
		target: attempt.expectedSha,
		lookup: async () => {
			const result = await deploys.listRuns(ref, attempt.workflow, 100);
			const run = result.ok
				? result.value.find(
						(run) =>
							!attempt.previousRunIds.includes(run.id) &&
							run.displayTitle === `Factory deploy ${attempt.expectedSha}`,
					)
				: undefined;
			return run
				? { kind: "confirmed", result: { workflowRunId: run.id } }
				: { kind: "unknown", reason: "Rollback dispatch is not yet observable" };
		},
		perform: async () => {
			const result = await deploys.dispatch(ref, attempt.workflow, attempt.branch, {
				[attempt.shaInput]: attempt.expectedSha,
			});
			return result.ok
				? { kind: "confirmed", result: { accepted: true } }
				: { kind: "unknown", reason: "Rollback dispatch could not be confirmed" };
		},
	});
	return outcome.kind === "confirmed";
}
async function poll(
	deps: DeploymentGateDeps,
	input: DeploymentInput,
	attempt: RollbackAttempt,
	deploys: ForgeDeploys,
	ref: RepoRef,
): Promise<DeploymentDecision> {
	if (input.now().getTime() - Date.parse(attempt.startedAt) >= attempt.timeoutMs)
		throw new Error("Rollback verification timed out; no automatic retry remains");
	const runs = await deploys.listRuns(ref, attempt.workflow, 100);
	if (!runs.ok) return { kind: "waiting" };
	const run = runs.value.find(
		(run) =>
			!attempt.previousRunIds.includes(run.id) &&
			run.displayTitle === `Factory deploy ${attempt.expectedSha}`,
	);
	if (run?.status !== "completed") return { kind: "waiting" };
	if (run.conclusion !== "success")
		throw new Error("Rollback workflow failed; owner intervention required");
	if (!attempt.verificationPolicy.artifactName) {
		const release = await loadDeploymentHistory(deploys, ref, attempt.environment);
		if (!release.ok || release.value.currentState === "unknown") return { kind: "waiting" };
		if (release.value.current?.sha !== attempt.expectedSha)
			throw new Error("Rollback platform version does not match the previous verified release");
	}

	await verifyRelease({
		sha: attempt.expectedSha,
		workflow: { deploys, ref, runId: run.id, startedAt: attempt.startedAt, now: input.now() },
		smokeUrl: attempt.smokeUrl,
		verification: attempt.verificationPolicy,
		timeoutMs: attempt.smokeTimeoutMs,
		fetch: deps.fetch,
	});
	await input.emit(input.run.id, "plan_run.rollback_verified", {
		expectedSha: attempt.expectedSha,
		workflowRunId: run.id,
		reason: attempt.reason,
		verification: { availability: true, version: true, scenario: true },
	});
	await (deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION).clear(input.planRun.projectId);
	return { kind: "repair", reason: attempt.reason, restoredSha: attempt.expectedSha };
}
/** One bounded recovery, then a normal budgeted implementation/review cycle. */
export async function recoverRelease(
	deps: DeploymentGateDeps,
	input: DeploymentInput,
	failed: DeploymentAttempt,
	reason: string,
): Promise<DeploymentDecision> {
	try {
		const events = await deps.repos.events.listByRun(input.run.id);
		const restored = events.find((e) => e.kind === "plan_run.rollback_verified");
		if (restored) {
			const payload = restored.payloadJson as { expectedSha: string; reason: string };
			return { kind: "repair", reason: payload.reason, restoredSha: payload.expectedSha };
		}
		const broken = events.find((e) => e.kind === "plan_run.rollback_failed");
		if (broken)
			return { kind: "incident", reason: (broken.payloadJson as { reason: string }).reason };
		const project = await deps.repos.projects.require(input.planRun.projectId);
		const ref = deps.forge.parseRepoRef(project.gitUrl);
		const deploys = deps.forge.deploys;
		if (!ref || !deploys) throw new Error("Rollback is unavailable for this forge");
		const saved = events.find((e) => e.kind === "plan_run.rollback_attempt");
		const attempt = saved
			? (saved.payloadJson as unknown as RollbackAttempt)
			: await prepare(deps, input, failed, reason, deploys, ref);
		if (input.now().getTime() - Date.parse(attempt.startedAt) >= attempt.timeoutMs)
			throw new Error("Rollback verification timed out; no automatic retry remains");
		if (!(await dispatch(deps, input, attempt, deploys, ref))) return { kind: "waiting" };
		return await poll(deps, input, attempt, deploys, ref);
	} catch (error) {
		const message = `Rollback stopped: ${formatError(error)}`;
		await input.emit(input.run.id, "plan_run.rollback_failed", { reason: message });
		return { kind: "incident", reason: message };
	}
}
