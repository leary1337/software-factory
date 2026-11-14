import { randomUUID } from "node:crypto";
import { StateTransitionError } from "../core/errors.ts";
import type { ApprovedPlanSnapshot, ApprovedTask, PlanApproval } from "../core/plan-approval.ts";
import type { ProjectRow } from "../db/schema.ts";
import { mergeProjectDefaults } from "../projects/settings.ts";
import { BUILTIN_AGENTS } from "../registry/builtins/index.ts";
import { readProjectDefaults } from "../runs/spawn/agent-cache.ts";
import { resolveExecutionProfiles } from "../runtime/adapters/execution-profiles.ts";
import { activeToolkitVersion } from "../toolkit/versions.ts";
import type { IssueTracker } from "../tracker/contract.ts";
import { approvalDigest } from "./approval.ts";
import { DEFAULT_TASK_BUDGETS } from "./approval-schema.ts";
import type { CreatePlanRunOrchestrationInput } from "./create.ts";

/** The existing launch API goes through the same immutable approval boundary. */
export async function freezeTrackerPlan(
	input: CreatePlanRunOrchestrationInput,
	project: ProjectRow,
	tracker: IssueTracker,
	childIds: readonly string[],
	renderedAgent: unknown,
): Promise<PlanApproval> {
	const tasks: ApprovedTask[] = await Promise.all(
		childIds.map(async (id, index) => {
			const issue = await tracker.getIssue(
				{ projectId: project.id, localPath: project.localPath },
				id,
			);
			return {
				seq: index + 1,
				id,
				title: issue.title ?? id,
				description: issue.description ?? "Complete the approved task",
				acceptance: ["Complete the task as described and pass the project's required checks."],
				dependsOn: index === 0 ? [] : [index],
				releaseAfter: index === childIds.length - 1,
				permissions: [],
				initialStatus: issue.status === "closed" ? "closed" : "open",
			};
		}),
	);
	const commandKey =
		input.commandKey ??
		`legacy:${approvalDigest([project.id, input.planId, tasks, input.agentName, input.ref, input.providerOverride, input.modelOverride])}`;
	const requestDigest = approvalDigest([
		project.id,
		input.planId,
		childIds,
		input.agentName,
		input.ref,
		input.providerOverride,
		input.modelOverride,
		input.promptTemplate,
	]);
	const prior = await input.repos.planApprovals.byCommand(commandKey);
	if (prior) {
		if (prior.snapshot.requestDigest !== requestDigest)
			throw new StateTransitionError(
				"Command identity already belongs to a different plan request",
			);
		return prior;
	}
	const defaults = await readProjectDefaults(input.warrenConfigs, project.id, project.localPath);
	const overrides = await input.repos.projectSettings.get(project.id);
	const settings = mergeProjectDefaults(defaults, overrides?.settings ?? {});
	const profiles = resolveExecutionProfiles(settings);
	if (input.modelOverride) profiles.implementation.model = input.modelOverride;
	const agents: Record<string, unknown> = Object.fromEntries(
		BUILTIN_AGENTS.map((agent) => [agent.name, agent]),
	);
	agents[input.agentName] = renderedAgent;
	const snapshot: ApprovedPlanSnapshot = {
		...(input.readiness ? { readiness: input.readiness } : {}),
		version: 1,
		requestDigest,
		taskSource: "tracker",
		projectId: project.id,
		title: input.planId ?? "Approved tasks",
		tasks,
		settings,
		profiles,
		toolkitVersion: await (input.resolveToolkitVersion ?? activeToolkitVersion)(),
		agents,
		budgets: { ...DEFAULT_TASK_BUDGETS, ...settings.taskBudgets },
		permissions: [],
		baseBranch: input.ref ?? project.defaultBranch,
		agentName: input.agentName,
		...(input.promptTemplate ? { promptTemplate: input.promptTemplate } : {}),
	};
	return input.repos.planApprovals.save({
		id: `approval_${randomUUID()}`,
		commandKey,
		digest: approvalDigest(snapshot),
		snapshot,
		revision: 1,
		supersedesId: null,
		planRunId: null,
		decision: "Approved through the plan launch request",
		createdAt: (input.now?.() ?? new Date()).toISOString(),
	});
}
