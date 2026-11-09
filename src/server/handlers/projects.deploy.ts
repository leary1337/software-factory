/**
 * The project's Production panel: what is live, how far the default branch is
 * ahead of it, and a button that starts the project's own deploy workflow.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { StateTransitionError, ValidationError } from "../../core/errors.ts";
import type {
	DeployRecord,
	DeployRun,
	Forge,
	ForgeDeploys,
	ForgeError,
	ForgeResult,
	PendingChanges,
	RepoRef,
} from "../../forge/contract.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";
import { loadProjectWarrenConfig } from "./projects.warren-config.ts";

const DEFAULT_WORKFLOW = "deploy.yml";
const DEFAULT_ENVIRONMENT = "production";
const HISTORY_SIZE = 5;
const CACHE_TTL_MS = 20_000;
/** Commits the factory writes for its own bookkeeping; nothing a user would notice. */
const BOOKKEEPING_TITLE = /^(chore\(warren\):|seeds: sync)/;

interface DeployTarget {
	readonly projectId: string;
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
	readonly current: DeployRecord | null;
	readonly behind: { readonly count: number; readonly changes: PendingChanges["commits"] } | null;
	readonly activeRun: DeployRun | null;
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

async function resolveTarget(deps: ServerDeps, id: string): Promise<DeployTarget | null> {
	const { project, loaded } = await loadProjectWarrenConfig(deps, id);
	const forge: Forge | undefined = deps.forge;
	const deploys = forge?.deploys;
	const ref = forge?.parseRepoRef(project.gitUrl) ?? null;
	if (deploys === undefined || ref === null || project.localPath === null) return null;
	const workflow = loaded.defaults?.deploy?.workflow ?? DEFAULT_WORKFLOW;
	if (!existsSync(join(project.localPath, ".github", "workflows", workflow))) return null;
	return {
		projectId: project.id,
		workflow,
		environment: loaded.defaults?.deploy?.environment ?? DEFAULT_ENVIRONMENT,
		branch: project.defaultBranch ?? "main",
		deploys,
		ref,
	};
}

async function loadActivePlan(deps: ServerDeps, projectId: string) {
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

async function buildOverview(deps: ServerDeps, target: DeployTarget): Promise<DeployOverview> {
	const { deploys, ref, workflow, environment, branch, projectId } = target;
	const errors: string[] = [];
	const [listed, runs] = await Promise.all([
		deploys.listDeployments(ref, environment, HISTORY_SIZE),
		deploys.listRuns(ref, workflow, 5),
	]);
	const history = unwrapOr(listed, [], errors);
	const current = history.find((d) => d.state === "success") ?? null;
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
		current,
		behind,
		activeRun: unwrapOr(runs, [], errors).find((r) => r.status !== "completed") ?? null,
		history,
		activePlan: await loadActivePlan(deps, projectId),
		error: errors[0] ?? null,
	};
}

// GitHub's hourly quota is shared with everything else on the account.
const overviewCache = new Map<string, { at: number; value: DeployOverview }>();

export function getProjectDeployHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const target = await resolveTarget(deps, id);
		if (target === null) return jsonResponse(200, { configured: false });
		const cached = overviewCache.get(id);
		if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
			return jsonResponse(200, cached.value);
		}
		const value = await buildOverview(deps, target);
		overviewCache.set(id, { at: Date.now(), value });
		return jsonResponse(200, value);
	};
}

export function startProjectDeployHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const target = await resolveTarget(deps, id);
		if (target === null) throw new ValidationError("this project has no deploy workflow");
		const runs = await target.deploys.listRuns(target.ref, target.workflow, 5);
		if (runs.ok && runs.value.some((r) => r.status !== "completed")) {
			throw new StateTransitionError("a deploy is already running for this project");
		}
		const sent = await target.deploys.dispatch(target.ref, target.workflow, target.branch);
		if (!sent.ok) throw new ValidationError(explain(sent.error));
		overviewCache.delete(id);
		return jsonResponse(202, { dispatched: true, branch: target.branch });
	};
}
