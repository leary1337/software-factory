import { createHash, randomUUID } from "node:crypto";
import { ValidationError } from "../core/errors.ts";
import type {
	ApprovedPlanSnapshot,
	ApprovedTask,
	PlanApproval,
	PreparePlanApproval,
} from "../core/plan-approval.ts";
import type { ReadinessEvidence } from "../core/readiness.ts";
import type { Repos } from "../db/repos/index.ts";
import { loadEffectiveProjectConfig } from "../projects/settings.ts";
import { resolveExecutionProfiles } from "../runtime/adapters/execution-profiles.ts";
import { syncApprovedSeeds } from "../seeds-cli/approved-plan-store.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import {
	DEFAULT_TASK_BUDGETS,
	PrepareApprovalSchema,
	TaskBudgetSchema,
} from "./approval-schema.ts";
import { withPlanRunLock } from "./lock.ts";

export function approvalDigest(value: unknown): string {
	return createHash("sha256")
		.update(
			JSON.stringify(value, (_key, entry: unknown) => {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
				return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
			}),
		)
		.digest("hex");
}
export interface ApprovalDeps {
	readiness?: ReadinessEvidence;
	repos: Repos;
	warrenConfigs?: WarrenConfigCache;
	publishToolkit: () => Promise<{ version: string }>;
	now?: () => Date;
}
function taskRows(input: PreparePlanApproval): ApprovedTask[] {
	const ids = new Set<string>();
	return input.tasks.map((task, index) => {
		const seq = index + 1;
		const id = task.id ?? `factory-${approvalDigest([input.commandKey, seq]).slice(0, 12)}`;
		if (ids.has(id)) throw new ValidationError(`Duplicate task: ${id}`);
		ids.add(id);
		const dependsOn = task.dependsOn ?? (index === 0 ? [] : [index]);
		if (dependsOn.some((dep) => dep >= seq))
			throw new ValidationError("Tasks may depend only on earlier steps.");
		return {
			...task,
			seq,
			id,
			dependsOn,
			releaseAfter: task.releaseAfter ?? seq === input.tasks.length,
			permissions: task.permissions ?? [],
			initialStatus: "open",
		};
	});
}
/** Prepare once for owner review; nothing executes until start is requested. */
export async function preparePlanApproval(
	deps: ApprovalDeps,
	raw: PreparePlanApproval,
): Promise<PlanApproval> {
	const parsed = PrepareApprovalSchema.safeParse(raw);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const input = parsed.data;
	return withPlanRunLock(`approval:${input.commandKey}`, async () => {
		const prior = await deps.repos.planApprovals.byCommand(input.commandKey);
		const tasks = taskRows(input);
		if (prior) {
			if (
				approvalDigest([input.projectId, input.title, tasks, input.permissions ?? []]) !==
				approvalDigest([
					prior.snapshot.projectId,
					prior.snapshot.title,
					prior.snapshot.tasks,
					prior.snapshot.permissions,
				])
			)
				throw new ValidationError(
					"This command key already names a different plan. Use a new command key for a new decision.",
				);
			return prior;
		}
		const project = await deps.repos.projects.require(input.projectId);
		const config = await loadEffectiveProjectConfig({
			project,
			settings: deps.repos.projectSettings,
			...(deps.warrenConfigs ? { warrenConfigs: deps.warrenConfigs } : {}),
		});
		if (config.errors.length)
			throw new ValidationError(config.errors.map((error) => error.message).join("; "));
		const settings = config.defaults ?? {};
		const agents = await freezeAgents(deps.repos);
		const snapshot: ApprovedPlanSnapshot = {
			...(deps.readiness ? { readiness: deps.readiness } : {}),
			version: 1,
			taskSource: "internal",
			projectId: project.id,
			title: input.title,
			tasks,
			profiles: resolveExecutionProfiles(settings),
			toolkitVersion: (await deps.publishToolkit()).version,
			settings: structuredClone(settings),
			agents,
			budgets: TaskBudgetSchema.parse({ ...DEFAULT_TASK_BUDGETS, ...settings.taskBudgets }),
			permissions: input.permissions ?? [],
			baseBranch: project.defaultBranch,
			agentName: "implementer",
		};
		return deps.repos.planApprovals.save({
			id: `approval_${randomUUID()}`,
			commandKey: input.commandKey,
			digest: approvalDigest(snapshot),
			snapshot,
			revision: 1,
			supersedesId: null,
			planRunId: null,
			decision: "Prepared for owner approval",
			createdAt: (deps.now?.() ?? new Date()).toISOString(),
		});
	});
}
export async function startApprovedPlan(repos: Repos, id: string) {
	return withPlanRunLock(`approval-start:${id}`, async () => {
		const approval = await repos.planApprovals.require(id);
		const snapshot = approval.snapshot;
		await syncApprovedSeeds(
			approval,
			approval.planRunId ? await repos.planRuns.listChildren(approval.planRunId) : [],
		);
		return repos.planRuns.create({
			approvalId: id,
			projectId: snapshot.projectId,
			agentName: snapshot.agentName,
			source: "issues",
			ref: snapshot.baseBranch,
			...(snapshot.promptTemplate ? { promptTemplate: snapshot.promptTemplate } : {}),
			children: snapshot.tasks.map((task) => ({
				seq: task.seq,
				seedId: task.id,
				...(task.initialStatus === "closed" ? { state: "skipped" as const } : {}),
			})),
		});
	});
}
export async function loadApprovedPlan(repos: Pick<Repos, "planApprovals">, planRunId: string) {
	return repos.planApprovals.forRun(planRunId);
}

async function freezeAgents(repos: Repos): Promise<Record<string, unknown>> {
	const agents: Record<string, unknown> = {};
	for (const name of ["implementer", "reviewer", "rework"]) {
		const row = await repos.agents.get(name);
		if (!row) throw new ValidationError(`Required agent is missing: ${name}`);
		agents[name] = structuredClone(row.renderedJson);
	}

	return agents;
}
