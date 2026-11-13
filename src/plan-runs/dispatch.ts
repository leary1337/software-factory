import { resolvePollTarget } from "../runs/pr-merge.ts";
/**
 * Spawn wrapper for the PlanRun coordinator (pl-a258 step 5 / warren-2623).
 *
 * `createPlanRunSpawn` mirrors `bootScheduler`'s spawnDispatch in
 * src/server/scheduler.ts: it composes a `CoordinatorSpawnFn` that the
 * coordinator can call without knowing about burrow pools, bridge
 * registries, project clones, or warren-config caches. The wrapper:
 *
 *   1. Loads the project so `ref` can fall back to `defaultBranch` when
 *      the PlanRun didn't pin one.
 *   2. Calls `spawnRun` with `trigger:'plan-run'`, the child's `seedId`
 *      (so spawnRun's existing post-dispatch `updateExtensions` write
 *      stamps `role`/`lastRunId`/`lastRunAt` onto the seed — mx-41ed65),
 *      and `metadata: {planRunId, planId, childSeq}` so the run is
 *      attributable to its PlanRun in audits.
 *   3. Hands the dispatched burrow run to `bridges.start` so its events
 *      stream into warren.events the same way scheduler and HTTP-dispatched
 *      runs do.
 *
 * Per-PlanRun spawn failures bubble as `RunSpawnError` (or a typed warren
 * error); the coordinator catches and marks the child failed.
 */

import type { Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import type { Forge } from "../forge/contract.ts";
import { mintGitCredential } from "../forge/credentials.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { spawnRun } from "../runs/index.ts";
import type { readApprovedDefaults } from "../runs/spawn/approved-defaults.ts";
import type { BridgeRegistry } from "../runs/stream/types.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { IssueTracker } from "../tracker/contract.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { preparePlanRunBudget } from "./budget-dispatch.ts";
import { recordPlanRunBudgetPolicy } from "./budget-policy.ts";
import type { CoordinatorSpawnFn } from "./coordinator.ts";

export interface CreatePlanRunSpawnInput {
	readonly repos: Repos;
	/**
	 * Resolved runtime provider (warren-c42c: required — the spawn seam is now
	 * exclusively `provider.create()`, no burrow-client fallback). Boot threads
	 * the boot-selected instance (`resolveRuntimeProvider`, honoring
	 * `WARREN_RUNTIME`); `spawnRun` dispatches through it.
	 */
	readonly runtimeProvider: RuntimeProvider;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	/**
	 * Boot-resolved forge. The pre-dispatch refresh fetch mints its credential
	 * HERE, per dispatch (forge-contract.md §4), instead of the boot-captured
	 * `GITHUB_TOKEN` this used to hold across the coordinator's whole lifetime.
	 */
	readonly forge?: Forge;
	readonly seedsCli: SeedsCliDeps;
	/** Boot-resolved IssueTracker (warren-5819) — threading seam for the child spawn. */
	readonly issueTracker?: IssueTracker;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
	/** Test seam — defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
	readonly readApprovedBudgetDefaults?: typeof readApprovedDefaults;
}

/** Per-plan overrides applied to each dispatch; the spend cap applies per child. */
function planRunOverrides(planRun: PlanRunRow) {
	return {
		...(planRun.providerOverride !== null ? { providerOverride: planRun.providerOverride } : {}),
		...(planRun.modelOverride !== null ? { modelOverride: planRun.modelOverride } : {}),
		...(planRun.maxCostUsd !== null ? { maxCostUsdOverride: planRun.maxCostUsd } : {}),
	};
}

async function reviewBaseBranch(
	input: CreatePlanRunSpawnInput,
	runId: string | null,
): Promise<string | undefined> {
	if (!input.forge || !runId) return undefined;
	const run = await input.repos.runs.require(runId);
	if (!run.prUrl) throw new Error("Review requires the task pull request.");
	const target = resolvePollTarget(input.forge, run.prUrl);
	if (target.kind === "unparseable") throw new Error("Cannot resolve review pull request.");
	const pr = await input.forge.getPullRequest(target.ref, target.pr);
	if (!pr.ok) throw new Error("Cannot read the review base branch.");
	return pr.value.baseBranch;
}

export function createPlanRunSpawn(input: CreatePlanRunSpawnInput): CoordinatorSpawnFn {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;
	return async ({
		planRun,
		child,
		prompt,
		agentName = planRun.agentName,
		existingBranch,
		baseCommit,
		reviewFindings,
		reviewRemainingCostUsd,
		onRunCreated,
	}) => {
		const project = await input.repos.projects.require(planRun.projectId);
		const ref = planRun.ref ?? project.defaultBranch;
		const gitCredential =
			input.forge === undefined ? undefined : await mintGitCredential(input.forge, project.gitUrl);
		const budget = await preparePlanRunBudget(input, { planRun, child }, project, gitCredential);
		const result = await spawnRunFn({
			repos: input.repos,
			runtimeProvider: input.runtimeProvider,
			agentName,
			...(agentName === "reviewer"
				? { reviewBaseBranch: await reviewBaseBranch(input, child.runId) }
				: {}),
			projectId: planRun.projectId,
			prompt,
			trigger: "plan-run",
			baseCommit,
			reviewFindings,
			reviewRemainingCostUsd,
			onRunRowCreated: async (runId) => {
				if (budget) {
					const now = (input.now ?? (() => new Date()))();
					const anchor = child.runId ?? runId;
					await input.repos.events.append({
						runId: anchor,
						sandboxEventSeq: ((await input.repos.events.maxSeqForRun(anchor)) ?? 0) + 1,
						ts: now.toISOString(),
						kind: "plan_run.budget_admitted",
						stream: "system",
						payload: { planRunId: planRun.id, childSeq: child.seq, runId },
					});
					await recordPlanRunBudgetPolicy(input.repos, planRun.id, runId, budget, now);
				}
				await onRunCreated?.(runId);
			},
			// warren-9ce3: underscore spelling matches the dispatch-origin
			// vocabulary (distinct from the hyphenated trigger column).
			dispatchOrigin: "plan_run",
			...(existingBranch === undefined ? { seedId: child.seedId } : {}),
			...planRunOverrides(planRun),
			...(existingBranch !== undefined ? { existingBranch } : { ref }),
			metadata: {
				planRunId: planRun.id,
				planId: planRun.planId,
				childSeq: child.seq,
			},
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			gitCredential,
			warrenConfigs: input.warrenConfigs,
			seedsCli: input.seedsCli,
			...(input.issueTracker !== undefined ? { issueTracker: input.issueTracker } : {}),
			dispatcherHandle: planRun.dispatcherHandle,
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		input.bridges.start(result.run.id, result.sandboxRun.id, result.sandbox.id);
		return { runId: result.run.id };
	};
}
