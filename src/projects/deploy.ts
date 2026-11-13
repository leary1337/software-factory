/**
 * The project's Production panel: what is live, how far the default branch is
 * ahead of it, and a button that starts the project's own deploy workflow.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { StateTransitionError, ValidationError } from "../core/errors.ts";
import type { DeploymentCurrentState } from "../core/wire.ts";
import type { Repos } from "../db/repos/index.ts";
import type {
	DeployRecord,
	DeployRun,
	Forge,
	ForgeDeploys,
	ForgeError,
	ForgeResult,
	PendingChanges,
	RepoRef,
} from "../forge/contract.ts";
import { loadWarrenConfig, type WarrenConfigCache } from "../warren-config/index.ts";

import {
	DEFAULT_DEPLOYMENT_ADMISSION,
	type DeploymentAdmission,
	ensureDeploymentAdmission,
} from "./deployment-admission.ts";
export interface ProjectDeployDeps {
	readonly repos: Pick<Repos, "projects" | "planRuns" | "events">;
	readonly deploymentAdmission?: DeploymentAdmission;
	readonly forge?: Forge;
	readonly warrenConfigs?: WarrenConfigCache;
}

const DEFAULT_WORKFLOW = "deploy.yml";
const DEFAULT_ENVIRONMENT = "production";
const HISTORY_SIZE = 5;
const CACHE_TTL_MS = 20_000;
/** Commits the factory writes for its own bookkeeping; nothing a user would notice. */
const BOOKKEEPING_TITLE = /^(chore\(warren\):|seeds: sync)/;

interface DeployTarget {
	readonly projectId: string;
	readonly shaInput?: string;
	readonly workflow: string;
	readonly environment: string;
	readonly branch: string;
	readonly deploys: ForgeDeploys;
	readonly ref: RepoRef;
}

export interface DeployOverview {
	readonly configured: true;
	readonly workflow: string;
	readonly environment: string;
	readonly branch: string;
	readonly candidateSha: string | null;
	readonly current: DeployRecord | null;
	readonly currentState: DeploymentCurrentState;
	readonly behind: { readonly count: number; readonly changes: PendingChanges["commits"] } | null;
	readonly activeRun: DeployRun | null;
	readonly latestRun: DeployRun | null;
	readonly history: readonly DeployRecord[];
	readonly activePlan: { readonly merged: number; readonly total: number } | null;
	readonly error: string | null;
}

function explain(error: ForgeError): string {
	if (error.kind === "unauthorized" || error.status === 403) {
		return "The Warren GitHub token needs Deployments: Read and Actions: Read and write.";
	}
	return error.detail;
}

async function resolveTarget(deps: ProjectDeployDeps, id: string): Promise<DeployTarget | null> {
	const project = await deps.repos.projects.require(id);
	const loaded =
		deps.warrenConfigs === undefined
			? await loadWarrenConfig({ projectPath: project.localPath })
			: await deps.warrenConfigs.get(project.id, project.localPath);
	if (loaded.errors.length > 0)
		throw new ValidationError("Project deployment configuration could not be read.");
	const forge: Forge | undefined = deps.forge;
	const deploys = forge?.deploys;
	const ref = forge?.parseRepoRef(project.gitUrl) ?? null;
	if (deploys === undefined || ref === null || project.localPath === null) return null;
	const workflow = loaded.defaults?.deploy?.workflow ?? DEFAULT_WORKFLOW;
	if (!existsSync(join(project.localPath, ".github", "workflows", workflow))) return null;
	return {
		projectId: project.id,
		...(loaded.defaults?.deploy?.shaInput ? { shaInput: loaded.defaults.deploy.shaInput } : {}),
		workflow,
		environment: loaded.defaults?.deploy?.environment ?? DEFAULT_ENVIRONMENT,
		branch: project.defaultBranch ?? "main",
		deploys,
		ref,
	};
}

async function loadActivePlan(deps: ProjectDeployDeps, projectId: string) {
	const [plan] = await deps.repos.planRuns.listByProjectAndState(projectId, "running");
	if (plan === undefined) return null;
	const children = await deps.repos.planRuns.listChildren(plan.id);
	return {
		merged: children.filter((c) => c.state === "merged").length,
		total: children.length,
	};
}

function unwrapOr<T>(result: ForgeResult<T>, fallback: T, errors: string[]): T {
	if (result.ok) return result.value;
	errors.push(explain(result.error));
	return fallback;
}

async function buildOverview(
	deps: ProjectDeployDeps,
	target: DeployTarget,
): Promise<DeployOverview> {
	const { deploys, ref, workflow, environment, branch, projectId } = target;
	const errors: string[] = [];
	const [listed, runs, candidate] = await Promise.all([
		loadDeploymentHistory(deploys, ref, environment),
		deploys.listRuns(ref, workflow, 100),
		deploys.resolveCommit(ref, branch),
	]);
	const release = unwrapOr(
		listed,
		{ history: [], current: null, currentState: "unknown" as const },
		errors,
	);
	const { history, current, currentState } = release;
	const workflowRuns = unwrapOr(runs, [], errors);
	let behind: DeployOverview["behind"] = null;
	if (current !== null) {
		const compared = unwrapOr(await deploys.compare(ref, current.sha, branch), null, errors);
		if (compared !== null) {
			behind = {
				count: compared.aheadBy,
				changes: compared.commits.filter((c) => !BOOKKEEPING_TITLE.test(c.title)),
			};
		}
	}
	return {
		configured: true,
		workflow,
		environment,
		branch,
		candidateSha: unwrapOr(candidate, null, errors),
		current,
		currentState,
		behind,
		activeRun: workflowRuns.find((r) => r.status !== "completed") ?? null,
		latestRun: workflowRuns[0] ?? null,
		history,
		activePlan: await loadActivePlan(deps, projectId),
		error: errors[0] ?? null,
	};
}

interface DeploymentHistory {
	readonly history: readonly DeployRecord[];
	readonly current: DeployRecord | null;
	readonly currentState: DeploymentCurrentState;
}

function releaseState(current: DeployRecord | null, hasUnknown: boolean): DeploymentCurrentState {
	if (hasUnknown) return "unknown";
	return current === null ? "none" : "deployed";
}

/** Cap API work; an incomplete scan is unknown, never evidence of no release. */
export async function loadDeploymentHistory(
	deploys: ForgeDeploys,
	ref: RepoRef,
	environment: string,
): Promise<ForgeResult<DeploymentHistory>> {
	let history: readonly DeployRecord[] = [];
	const pageSize = 20;
	let hasUnknown = false;
	for (let page = 1; page <= 10; page++) {
		const result = await deploys.listDeployments(ref, environment, pageSize, page);
		if (!result.ok) return result;
		if (page === 1) history = result.value.slice(0, HISTORY_SIZE);
		const currentIndex = result.value.findIndex((deployment) => deployment.state === "success");
		const inspected = currentIndex < 0 ? result.value : result.value.slice(0, currentIndex);
		hasUnknown ||= inspected.some((deployment) => deployment.state === "unknown");
		const current = result.value[currentIndex] ?? null;
		if (current !== null)
			return {
				ok: true,
				value: { history, current, currentState: releaseState(current, hasUnknown) },
			};
		if (result.value.length < pageSize)
			return {
				ok: true,
				value: { history, current: null, currentState: releaseState(null, hasUnknown) },
			};
	}
	return { ok: true, value: { history, current: null, currentState: "unknown" } };
}

// Scope cache/dispatch locks to the project repository, not process-global ids.
const scopes = new WeakMap<
	ProjectDeployDeps["repos"]["projects"],
	{
		cache: Map<string, { at: number; signature: string; value: DeployOverview }>;
	}
>();
function scope(deps: ProjectDeployDeps) {
	let state = scopes.get(deps.repos.projects);
	if (state === undefined) {
		state = { cache: new Map() };
		scopes.set(deps.repos.projects, state);
	}
	return state;
}

export async function getProjectDeployOverview(deps: ProjectDeployDeps, id: string) {
	const target = await resolveTarget(deps, id);
	if (target === null) return { configured: false as const };
	const { cache } = scope(deps);
	const signature = JSON.stringify([
		target.ref,
		target.workflow,
		target.environment,
		target.branch,
	]);
	const cached = cache.get(id);
	if (
		cached !== undefined &&
		cached.signature === signature &&
		Date.now() - cached.at < CACHE_TTL_MS
	)
		return cached.value;
	const value = await buildOverview(deps, target);
	if (value.error === null && value.currentState !== "unknown")
		cache.set(id, { at: Date.now(), signature, value });
	return value;
}

export async function startProjectDeploy(deps: ProjectDeployDeps, id: string) {
	const admission = deps.deploymentAdmission ?? DEFAULT_DEPLOYMENT_ADMISSION;
	return admission.withLock(id, () => dispatchProjectDeploy(deps, id, admission));
}

async function dispatchProjectDeploy(
	deps: ProjectDeployDeps,
	id: string,
	admission: DeploymentAdmission,
) {
	const { cache } = scope(deps);
	const target = await resolveTarget(deps, id);
	if (target === null) throw new ValidationError("this project has no deploy workflow");
	await ensureDeploymentAdmission(admission, id, target.deploys, target.ref);
	const plans = await deps.repos.planRuns.listByProjectAndState(id);
	for (const plan of plans) {
		const children = await deps.repos.planRuns.listChildren(plan.id);
		const events = await deps.repos.events.listByRunIds(
			children.flatMap((child) => (child.runId === null ? [] : [child.runId])),
		);
		if (
			events.some(
				(event) =>
					event.kind === "plan_run.deployment_attempt" &&
					!events.some(
						(done) => done.runId === event.runId && done.kind === "plan_run.deployment_verified",
					),
			)
		)
			throw new StateTransitionError(
				"Automatic production verification is unresolved for this project",
			);
	}
	const runs = await target.deploys.listRuns(target.ref, target.workflow, 100);
	if (!runs.ok)
		throw new ValidationError(`Cannot check active deployments: ${explain(runs.error)}`);
	if (runs.value.some((r) => r.status !== "completed"))
		throw new StateTransitionError("a deploy is already running for this project");

	let inputs: Readonly<Record<string, string>> | undefined;
	if (target.shaInput) {
		const commit = await target.deploys.resolveCommit(target.ref, target.branch);
		if (!commit.ok) throw new ValidationError("Cannot resolve the branch commit for deployment");
		inputs = { [target.shaInput]: commit.value };
	}
	await admission.write(id, {
		ownerRunId: null,
		workflow: target.workflow,
		branch: target.branch,
		requestedAt: new Date().toISOString(),
		previousRunIds: runs.value.map((run) => run.id),
	});
	const sent = await target.deploys.dispatch(target.ref, target.workflow, target.branch, inputs);
	if (!sent.ok) throw new ValidationError(explain(sent.error));
	cache.delete(id);
	return { dispatched: true, branch: target.branch };
}
