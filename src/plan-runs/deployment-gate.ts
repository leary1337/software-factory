import { productionVerificationFromEvent } from "./production-verification.ts";
/** Durable, opt-in delivery gate. A dispatch with an uncertain outcome is never repeated. */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { DeployRecord, ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { loadDeploymentHistory } from "../projects/deploy.ts";
import {
	DEFAULT_DEPLOYMENT_ADMISSION,
	ensureDeploymentAdmission,
} from "../projects/deployment-admission.ts";
import { validateDeploymentWorkflow } from "../projects/deployment-workflow.ts";
import { verifyRelease } from "../projects/release-verification.ts";
import { recordLearningEvidence } from "../runs/learning-evidence.ts";
import { resolvePollTarget } from "../runs/pr-merge.ts";
import { reconcileEffect } from "./effects.ts";
import { releasePolicy } from "./release-policy.ts";
import { recoverRelease } from "./release-rollback.ts";

export type {
	CoordinatorDeploymentFn,
	DeploymentDecision,
	DeploymentInput,
	ProjectDeploymentBlocker,
} from "./deployment-contract.ts";

import type {
	DeploymentAttempt as Attempt,
	CoordinatorDeploymentFn,
	DeploymentDecision,
	DeploymentInput,
	DeploymentGateDeps as Deps,
	ProjectDeploymentBlocker,
} from "./deployment-contract.ts";

const WAIT: DeploymentDecision = { kind: "waiting" };
const PASS: DeploymentDecision = { kind: "passed" };

async function incident(
	deps: Deps,
	input: DeploymentInput,
	reason: string,
): Promise<DeploymentDecision> {
	await input.emit(input.run.id, "plan_run.deployment_incident", {
		planRunId: input.planRun.id,
		projectId: input.planRun.projectId,
		seq: input.child.seq,
		reason,
	});
	await recordLearningEvidence(deps.repos, input.emit, input.run.id, {
		sourceKey: `deployment:${input.planRun.id}:${input.child.seq}:${reason}`,
		trigger: reason.startsWith("Production smoke") ? "smoke_failure" : "deployment_failure",
		sourceRunId: input.run.id,
		projectId: input.planRun.projectId,
		planRunId: input.planRun.id,
		childSeq: input.child.seq,
		report: reason,
	});
	return { kind: "incident", reason };
}

async function failedRelease(
	deps: Deps,
	input: DeploymentInput,
	attempt: Attempt,
	reason: string,
): Promise<DeploymentDecision> {
	return attempt.verification
		? recoverRelease(deps, input, attempt, reason)
		: incident(deps, input, reason);
}

async function assertPinnedWorkflow(
	deploys: ForgeDeploys,
	ref: RepoRef,
	workflow: string,
	branch: string,
	shaInput: string | undefined,
): Promise<void> {
	if (!shaInput) throw new Error("Automatic deployment requires an explicit SHA input");
	const source = await deploys.readWorkflow(ref, workflow, branch);
	if (!source.ok || !validateDeploymentWorkflow(source.value, shaInput))
		throw new Error(
			"Deployment workflow must require the configured SHA input and pin checkout to it",
		);
}

async function prepare(
	deps: Deps,
	input: DeploymentInput,
	deploys: ForgeDeploys,
	ref: RepoRef,
): Promise<Attempt | null> {
	const { deploy: config } = await releasePolicy(
		deps,
		input.planRun.id,
		input.planRun.projectId,
		input.child.seq,
	);
	if (!config?.autoDeploy) return null;
	if (!config.verification)
		throw new Error("Approved delivery requires application version and scenario checks");
	const target = resolvePollTarget(deps.forge, input.prUrl);
	if (target.kind === "unparseable") throw new Error("Cannot resolve the merged pull request");
	const pr = await deps.forge.getPullRequest(ref, target.pr);
	if (
		!pr.ok ||
		pr.value.lifecycle !== "merged" ||
		!/^[a-f0-9]{40}$/.test(pr.value.mergedCommit ?? "")
	)
		throw new Error("Cannot establish the exact merged commit for deployment");
	const workflow = config.workflow ?? "deploy.yml";
	const runs = await deploys.listRuns(ref, workflow, 100);
	if (!runs.ok) throw new Error("Cannot check active deployment workflows");
	if (runs.value.some((run) => run.status !== "completed"))
		throw new Error("Another deployment workflow is active; owner intervention required");
	await assertPinnedWorkflow(deploys, ref, workflow, pr.value.baseBranch, config.shaInput);
	if (!config.smokeUrl) throw new Error("Automatic deployment requires an explicit smoke URL");
	return {
		verification: config.verification,
		rollback: config.rollback,
		expectedSha: pr.value.mergedCommit ?? "",
		shaInput: config.shaInput ?? "",
		branch: pr.value.baseBranch,
		workflow,
		environment: config.environment ?? "production",
		smokeUrl: config.smokeUrl,
		timeoutMs: config.timeoutMs,
		smokeTimeoutMs: config.smokeTimeoutMs,
		startedAt: input.now().toISOString(),
		previousRunIds: runs.value.map((run) => run.id),
	};
}

async function start(
	deps: Deps,
	input: DeploymentInput,
	deploys: ForgeDeploys,
	ref: RepoRef,
	attempt: Attempt,
	recordIntent = true,
): Promise<DeploymentDecision> {
	if (recordIntent) {
		// Persist BEFORE external mutation: interruption here requires owner intervention.
		await input.emit(input.run.id, "plan_run.deployment_attempt", { ...attempt });
		await (deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION).write(
			input.planRun.projectId,
			{
				ownerRunId: input.run.id,
				workflow: attempt.workflow,
				branch: attempt.branch,
				requestedAt: attempt.startedAt,
				previousRunIds: attempt.previousRunIds,
			},
		);
	}
	const sent = await reconcileEffect(deps.repos, {
		identity: `${input.planRun.id}:${input.child.seq}:deploy:${attempt.expectedSha}`,
		planRunId: input.planRun.id,
		seq: input.child.seq,
		kind: "deploy",
		target: attempt.expectedSha,
		lookup: async () => {
			const runs = await deploys.listRuns(ref, attempt.workflow, 100);
			const matching = runs.ok
				? runs.value.find(
						(run) =>
							!attempt.previousRunIds.includes(run.id) &&
							run.displayTitle === `Factory deploy ${attempt.expectedSha}`,
					)
				: undefined;
			return matching
				? { kind: "confirmed", result: { workflowRunId: matching.id } }
				: { kind: "unknown", reason: "Deployment dispatch is not yet observable" };
		},
		perform: async () => {
			const result = await deploys.dispatch(ref, attempt.workflow, attempt.branch, {
				[attempt.shaInput]: attempt.expectedSha,
			});
			return result.ok
				? { kind: "confirmed", result: { accepted: true } }
				: { kind: "unknown", reason: "Deployment dispatch could not be confirmed" };
		},
	});
	if (sent.kind !== "confirmed") return WAIT;
	await input.emit(input.run.id, "plan_run.deployment_dispatched", {
		expectedSha: attempt.expectedSha,
	});
	return WAIT;
}

function isExpectedRelease(current: DeployRecord | null, attempt: Attempt): boolean {
	return (
		current !== null &&
		current.sha === attempt.expectedSha &&
		Number.isFinite(Date.parse(current.createdAt)) &&
		Date.parse(current.createdAt) >= Date.parse(attempt.startedAt) - 1000
	);
}

async function finishApplicationChecks(
	deps: Deps,
	input: DeploymentInput,
	attempt: Attempt,
	workflowRunId: number,
	deploys: ForgeDeploys,
	ref: RepoRef,
): Promise<DeploymentDecision | null> {
	if (!attempt.verification)
		throw new Error(
			"Application version and scenario verification were not approved; update the release policy before continuing",
		);
	await verifyRelease({
		sha: attempt.expectedSha,
		workflow: {
			deploys,
			ref,
			runId: workflowRunId,
			startedAt: attempt.startedAt,
			now: input.now(),
		},
		smokeUrl: attempt.smokeUrl,
		verification: attempt.verification,
		timeoutMs: attempt.smokeTimeoutMs,
		fetch: deps.fetch,
	});
	await input.emit(input.run.id, "plan_run.deployment_verified", {
		expectedSha: attempt.expectedSha,
		workflowRunId: workflowRunId,
		environment: attempt.environment,
		verification: { availability: true, version: true, scenario: true },
		compatibility: attempt.rollback,
		verificationPolicy: attempt.verification,
		smokeUrl: attempt.smokeUrl,
		smokeTimeoutMs: attempt.smokeTimeoutMs,
	});

	return null;
}

async function verifyPlatformCommit(
	deps: Deps,
	input: DeploymentInput,
	deploys: ForgeDeploys,
	ref: RepoRef,
	attempt: Attempt,
): Promise<DeploymentDecision | null> {
	if (!attempt.verification?.artifactName) {
		const release = await loadDeploymentHistory(deploys, ref, attempt.environment);
		if (!release.ok || release.value.currentState === "unknown") return WAIT;
		if (!isExpectedRelease(release.value.current, attempt))
			return failedRelease(
				deps,
				input,
				attempt,
				"Production does not report the exact merged commit as active",
			);
	}

	return null;
}

async function poll(
	deps: Deps,
	input: DeploymentInput,
	deploys: ForgeDeploys,
	ref: RepoRef,
	attempt: Attempt,
): Promise<DeploymentDecision> {
	const baseline = Math.max(
		Date.parse(attempt.startedAt),
		Date.parse(input.planRun.resumedAt ?? attempt.startedAt),
	);
	if (input.now().getTime() - baseline >= attempt.timeoutMs)
		return failedRelease(deps, input, attempt, "Deployment verification timed out");
	const runs = await deploys.listRuns(ref, attempt.workflow, 100);
	if (!runs.ok) return WAIT;
	const candidates = runs.value.filter(
		(run) =>
			!attempt.previousRunIds.includes(run.id) &&
			Date.parse(run.createdAt) >= Date.parse(attempt.startedAt) - 1000,
	);
	const matching = candidates.find(
		(run) => run.displayTitle === `Factory deploy ${attempt.expectedSha}`,
	);
	if (!matching) {
		if (candidates.length > 0)
			return failedRelease(
				deps,
				input,
				attempt,
				"The deployment workflow ran a different commit; the queue remains stopped",
			);
		return WAIT;
	}
	if (matching.status !== "completed") return WAIT;
	if (matching.conclusion !== "success")
		return failedRelease(
			deps,
			input,
			attempt,
			`Deployment workflow finished with ${matching.conclusion ?? "unknown status"}`,
		);
	const platform = await verifyPlatformCommit(deps, input, deploys, ref, attempt);
	if (platform) return platform;

	let application: DeploymentDecision | null;
	try {
		application = await finishApplicationChecks(deps, input, attempt, matching.id, deploys, ref);
	} catch (error) {
		return failedRelease(deps, input, attempt, formatError(error));
	}
	if (application) return application;
	await (deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION).clear(input.planRun.projectId);
	return PASS;
}

async function waitForBoundary(deps: Deps, input: DeploymentInput): Promise<DeploymentDecision> {
	const events = await deps.repos.events.listByRun(input.run.id);
	if (!events.some((event) => event.kind === "plan_run.release_pending"))
		await input.emit(input.run.id, "plan_run.release_pending", {
			planRunId: input.planRun.id,
			seq: input.child.seq,
			reason: "Merged; waiting for the approved release boundary",
		});
	return PASS;
}

async function reconcileInterruptedDispatch(
	deps: Deps,
	input: DeploymentInput,
	deploys: ForgeDeploys,
	target: RepoRef,
	attempt: Attempt,
): Promise<DeploymentDecision> {
	if (input.now().getTime() - Date.parse(attempt.startedAt) >= attempt.timeoutMs)
		return incident(
			deps,
			input,
			"Deployment dispatch remains unconfirmed after its wait budget; inspect the platform before another release",
		);
	return start(deps, input, deploys, target, attempt, false);
}

function shouldResumeRollback(
	events: readonly { kind: string; ts: string }[],
	resumedAt: string | null,
): boolean {
	if (!events.some((event) => event.kind.startsWith("plan_run.rollback_"))) return false;
	if (events.some((event) => event.kind === "plan_run.rollback_attempt")) return true;
	const failed = [...events].reverse().find((event) => event.kind === "plan_run.rollback_failed");
	return !failed || !resumedAt || Date.parse(resumedAt) <= Date.parse(failed.ts);
}

async function advanceDeployment(deps: Deps, input: DeploymentInput): Promise<DeploymentDecision> {
	const policy = await releasePolicy(
		deps,
		input.planRun.id,
		input.planRun.projectId,
		input.child.seq,
	);
	if (!policy.boundary) return waitForBoundary(deps, input);
	const events = await deps.repos.events.listByRun(input.run.id);
	if (events.some((event) => productionVerificationFromEvent(event) !== null)) {
		const admission = deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION;
		if ((await admission.read(input.planRun.projectId))?.ownerRunId === input.run.id)
			await admission.clear(input.planRun.projectId);
		return PASS;
	}
	const saved = events.find((event) => event.kind === "plan_run.deployment_attempt");
	const project = await deps.repos.projects.require(input.planRun.projectId);
	const target = deps.forge.parseRepoRef(project.gitUrl);
	const deploys = deps.forge.deploys;
	if (!saved && !policy.deploy?.autoDeploy) return PASS;
	if (!deploys || !target)
		return incident(deps, input, "Automatic deployment is unsupported by this forge");
	await ensureDeploymentAdmission(
		deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION,
		input.planRun.projectId,
		deploys,
		target,
		input.run.id,
	);
	if (!saved) {
		const attempt = await prepare(deps, input, deploys, target);
		return attempt === null ? PASS : await start(deps, input, deploys, target, attempt);
	}
	const attempt = saved.payloadJson as unknown as Attempt;
	if (shouldResumeRollback(events, input.planRun.resumedAt))
		return recoverRelease(deps, input, attempt, "Deployment verification failed");
	const sent = events.some((event) => event.kind === "plan_run.deployment_dispatched");
	if (!sent) return reconcileInterruptedDispatch(deps, input, deploys, target, attempt);
	return await poll(deps, input, deploys, target, attempt);
}
export function createDeploymentGate(deps: Deps): CoordinatorDeploymentFn {
	return async (input) => {
		try {
			return await (deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION).withLock(
				input.planRun.projectId,
				() => advanceDeployment(deps, input),
			);
		} catch (error) {
			return incident(deps, input, formatError(error));
		}
	};
}

export async function hasPendingDeployment(
	repos: Pick<Repos, "events">,
	runIds: readonly string[],
): Promise<boolean> {
	const events = await repos.events.listByRunIds(runIds);
	return events.some(
		(event) =>
			event.kind === "plan_run.deployment_attempt" &&
			!events.some(
				(done) => done.runId === event.runId && productionVerificationFromEvent(done) !== null,
			),
	);
}

/** A failed delivery blocks every other plan in this project until explicit resume succeeds. */
export function createProjectDeploymentBlocker(
	deps: Pick<Deps, "repos">,
): ProjectDeploymentBlocker {
	return async (plan) => {
		const failed = await deps.repos.planRuns.listByProjectAndState(plan.projectId, "failed");
		if (failed.some((other) => other.failureReason === "deployment_incident"))
			return "Production incident needs owner intervention";
		const running = await deps.repos.planRuns.listByProjectAndState(plan.projectId, [
			"running",
			"cancelled",
		]);
		for (const other of running.filter((candidate) => candidate.id !== plan.id)) {
			const children = await deps.repos.planRuns.listChildren(other.id);
			const pending = await hasPendingDeployment(
				deps.repos,
				children.flatMap((child) => (child.runId === null ? [] : [child.runId])),
			);
			if (pending) return "Waiting for another plan's production verification";
		}
		return null;
	};
}
