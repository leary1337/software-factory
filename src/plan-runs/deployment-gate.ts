/** Durable, opt-in delivery gate. A dispatch with an uncertain outcome is never repeated. */
import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow, PlanRunRow, RunRow } from "../db/schema.ts";
import type { DeployRecord, Forge, ForgeDeploys, RepoRef } from "../forge/contract.ts";
import { loadDeploymentHistory } from "../projects/deploy.ts";
import {
	DEFAULT_DEPLOYMENT_ADMISSION,
	type DeploymentAdmission,
	ensureDeploymentAdmission,
} from "../projects/deployment-admission.ts";
import { validateDeploymentWorkflow } from "../projects/deployment-workflow.ts";
import { recordLearningEvidence } from "../runs/learning-evidence.ts";
import { resolvePollTarget } from "../runs/pr-merge.ts";
import { loadWarrenConfig, type WarrenConfigCache } from "../warren-config/index.ts";
import type { CoordinatorEmitFn } from "./coordinator.ts";

export type DeploymentDecision =
	| { readonly kind: "passed" | "waiting" }
	| { readonly kind: "incident"; readonly reason: string };
export interface DeploymentInput {
	readonly planRun: PlanRunRow;
	readonly child: PlanRunChildRow;
	readonly run: RunRow;
	readonly prUrl: string;
	readonly emit: CoordinatorEmitFn;
	readonly now: () => Date;
}
export type CoordinatorDeploymentFn = (input: DeploymentInput) => Promise<DeploymentDecision>;
export type ProjectDeploymentBlocker = (plan: PlanRunRow) => Promise<string | null>;
interface Deps {
	readonly repos: Pick<Repos, "projects" | "planRuns" | "events">;
	readonly forge: Forge;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly fetch?: typeof fetch;
	readonly deploymentAdmission?: DeploymentAdmission;
}
interface Attempt {
	readonly expectedSha: string;
	readonly shaInput: string;
	readonly branch: string;
	readonly workflow: string;
	readonly environment: string;
	readonly smokeUrl: string;
	readonly timeoutMs: number;
	readonly smokeTimeoutMs: number;
	readonly startedAt: string;
	readonly previousRunIds: readonly number[];
}
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
	const project = await deps.repos.projects.require(input.planRun.projectId);
	const loaded =
		deps.warrenConfigs === undefined
			? await loadWarrenConfig({ projectPath: project.localPath })
			: await deps.warrenConfigs.get(project.id, project.localPath);
	if (loaded.errors.length > 0) throw new Error("Deployment configuration could not be read");
	const config = loaded.defaults?.deploy;
	if (!config?.autoDeploy) return null;
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
): Promise<DeploymentDecision> {
	// Persist BEFORE external mutation: interruption here requires owner intervention.
	await input.emit(input.run.id, "plan_run.deployment_attempt", { ...attempt });
	await (deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION).write(input.planRun.projectId, {
		ownerRunId: input.run.id,
		workflow: attempt.workflow,
		branch: attempt.branch,
		requestedAt: attempt.startedAt,
		previousRunIds: attempt.previousRunIds,
	});
	const sent = await deploys.dispatch(ref, attempt.workflow, attempt.branch, {
		[attempt.shaInput]: attempt.expectedSha,
	});
	if (!sent.ok)
		return incident(
			deps,
			input,
			"Deployment dispatch could not be confirmed; inspect GitHub before resuming",
		);
	await input.emit(input.run.id, "plan_run.deployment_dispatched", {
		expectedSha: attempt.expectedSha,
	});
	return WAIT;
}

async function smoke(fetchImpl: typeof fetch, attempt: Attempt): Promise<string | null> {
	try {
		const response = await fetchImpl(attempt.smokeUrl, {
			method: "GET",
			redirect: "error",
			signal: AbortSignal.timeout(attempt.smokeTimeoutMs),
			headers: { "User-Agent": "software-factory-smoke" },
		});
		await response.body?.cancel();
		return response.ok ? null : `Production smoke returned HTTP ${response.status}`;
	} catch {
		return "Production smoke failed or timed out";
	}
}

function isExpectedRelease(current: DeployRecord | null, attempt: Attempt): boolean {
	return (
		current !== null &&
		current.sha === attempt.expectedSha &&
		Number.isFinite(Date.parse(current.createdAt)) &&
		Date.parse(current.createdAt) >= Date.parse(attempt.startedAt) - 1000
	);
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
		return incident(deps, input, "Deployment verification timed out");
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
			return incident(
				deps,
				input,
				"The deployment workflow ran a different commit; the queue remains stopped",
			);
		return WAIT;
	}
	if (matching.status !== "completed") return WAIT;
	if (matching.conclusion !== "success")
		return incident(
			deps,
			input,
			`Deployment workflow finished with ${matching.conclusion ?? "unknown status"}`,
		);
	const release = await loadDeploymentHistory(deploys, ref, attempt.environment);
	if (!release.ok || release.value.currentState === "unknown") return WAIT;
	if (!isExpectedRelease(release.value.current, attempt))
		return incident(deps, input, "Production does not report the exact merged commit as active");
	const failure = await smoke(deps.fetch ?? fetch, attempt);
	if (failure !== null) return incident(deps, input, failure);
	await input.emit(input.run.id, "plan_run.deployment_verified", {
		expectedSha: attempt.expectedSha,
		workflowRunId: matching.id,
		environment: attempt.environment,
	});
	await (deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION).clear(input.planRun.projectId);
	return PASS;
}

async function isEnabled(deps: Deps, projectId: string): Promise<boolean> {
	const project = await deps.repos.projects.require(projectId);
	const loaded =
		deps.warrenConfigs === undefined
			? await loadWarrenConfig({ projectPath: project.localPath })
			: await deps.warrenConfigs.get(project.id, project.localPath);
	if (loaded.errors.length > 0) throw new Error("Deployment configuration could not be read");
	return loaded.defaults?.deploy?.autoDeploy === true;
}

async function advanceDeployment(deps: Deps, input: DeploymentInput): Promise<DeploymentDecision> {
	const events = await deps.repos.events.listByRun(input.run.id);
	if (events.some((event) => event.kind === "plan_run.deployment_verified")) {
		const admission = deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION;
		if ((await admission.read(input.planRun.projectId))?.ownerRunId === input.run.id)
			await admission.clear(input.planRun.projectId);
		return PASS;
	}
	const saved = events.find((event) => event.kind === "plan_run.deployment_attempt");
	const project = await deps.repos.projects.require(input.planRun.projectId);
	const target = deps.forge.parseRepoRef(project.gitUrl);
	const deploys = deps.forge.deploys;
	if (!saved && !(await isEnabled(deps, project.id))) return PASS;
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
	const sent = events.some((event) => event.kind === "plan_run.deployment_dispatched");
	if (!sent && (input.planRun.resumedAt === null || input.planRun.resumedAt <= saved.ts))
		return incident(
			deps,
			input,
			"Deployment dispatch was interrupted; inspect GitHub and resume explicitly",
		);
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
				(done) => done.runId === event.runId && done.kind === "plan_run.deployment_verified",
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
