/**
 * Convenience surface that wires every repo against a single drizzle handle.
 * Higher layers grab one Repos and pass it through.
 */

import type { AnyWarrenDb } from "../client.ts";
import { AgentsRepo } from "./agents.ts";
import { DispatchContextRepo } from "./dispatch-context.ts";
import { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";
import { PlanApprovalsRepo } from "./plan-approvals.ts";
import { PlanEffectsRepo } from "./plan-effects.ts";
import { PlanRunsRepo } from "./plan-runs.ts";
import { ProjectSettingsRepo } from "./project-settings.ts";
import { ProjectsRepo } from "./projects.ts";
import { RunInboxRepo } from "./run-inbox.ts";
import { RunsRepo } from "./runs.ts";
import { TaskAttemptsRepo } from "./task-attempts.ts";
import { ToolCallsRepo } from "./tool-calls.ts";
import { TriggersRepo } from "./triggers.ts";

export interface Repos {
	agents: AgentsRepo;
	projects: ProjectsRepo;
	projectSettings: ProjectSettingsRepo;
	runs: RunsRepo;
	events: EventsRepo;
	triggers: TriggersRepo;
	planRuns: PlanRunsRepo;
	planEffects: PlanEffectsRepo;
	taskAttempts: TaskAttemptsRepo;
	planApprovals: PlanApprovalsRepo;
	runInbox: RunInboxRepo;
	toolCalls: ToolCallsRepo;
	dispatchContext: DispatchContextRepo;
}

export function createRepos(db: AnyWarrenDb): Repos {
	const adapter = DrizzleAdapter.for(db);
	return {
		agents: new AgentsRepo(adapter),
		projects: new ProjectsRepo(adapter),
		projectSettings: new ProjectSettingsRepo(adapter),
		runs: new RunsRepo(adapter),
		events: new EventsRepo(adapter),
		triggers: new TriggersRepo(adapter),
		planRuns: new PlanRunsRepo(adapter),
		planEffects: new PlanEffectsRepo(adapter),
		taskAttempts: new TaskAttemptsRepo(adapter),
		planApprovals: new PlanApprovalsRepo(adapter),
		runInbox: new RunInboxRepo(adapter),
		toolCalls: new ToolCallsRepo(adapter),
		dispatchContext: new DispatchContextRepo(adapter),
	};
}

export type { DispatchFacts } from "./dispatch-context.ts";
export {
	AgentsRepo,
	DispatchContextRepo,
	EventsRepo,
	PlanRunsRepo,
	ProjectSettingsRepo,
	ProjectsRepo,
	RunInboxRepo,
	RunsRepo,
	ToolCallsRepo,
	TriggersRepo,
};
