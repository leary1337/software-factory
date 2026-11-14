import type { PlanRunBudgetConfig } from "../core/plan-run-budget.ts";
import type { ProjectRow } from "../db/schema.ts";
import { readApprovedDefaults } from "../runs/spawn/approved-defaults.ts";
import { DefaultsConfigSchema } from "../warren-config/schema.ts";
import type { GitSpawnCredential } from "../workspace/git/credential-env.ts";
import { loadTaskApproval } from "./approved-dispatch.ts";
import { enforcePlanRunBudget } from "./budget.ts";
import { readPlanRunBudgetPolicy, recordPlanRunBudgetPolicy } from "./budget-policy.ts";
import type { CoordinatorSpawnInput } from "./coordinator.ts";
import type { CreatePlanRunSpawnInput } from "./dispatch.ts";

/** Every coordinator dispatch crosses this gate, including cold reviews and retries. */
export async function preparePlanRunBudget(
	input: CreatePlanRunSpawnInput,
	request: Pick<CoordinatorSpawnInput, "planRun" | "child">,
	project: ProjectRow,
	gitCredential: GitSpawnCredential | undefined,
): Promise<PlanRunBudgetConfig | null> {
	const snapshot = await loadTaskApproval(input.repos, request.planRun.id, request.child.seq);
	if (snapshot) {
		const limits = DefaultsConfigSchema.parse(snapshot.snapshot.settings).planRunBudget;
		await enforcePlanRunBudget(
			input.repos,
			request.planRun,
			request.child,
			limits,
			(input.now ?? (() => new Date()))(),
		);
		return limits ?? null;
	}
	const cached = await input.warrenConfigs.get(project.id, project.localPath);
	const previous = await readPlanRunBudgetPolicy(input.repos, request.planRun);
	// Old projects remain compatible. Once enabled, persisted policy forces a
	// remote read even if an agent removed the hint from the shared clone.
	if (!cached.defaults?.planRunBudget && previous === null) return null;
	const approved = await (input.readApprovedBudgetDefaults ?? readApprovedDefaults)(
		{ projectSpawn: input.projectSpawn, gitCredential },
		project,
	);
	const limits = approved.planRunBudget ?? {};
	const now = (input.now ?? (() => new Date()))();
	const children = await input.repos.planRuns.listChildren(request.planRun.id);
	const anchor = request.child.runId ?? [...children].reverse().find((child) => child.runId)?.runId;
	if (anchor) await recordPlanRunBudgetPolicy(input.repos, request.planRun.id, anchor, limits, now);
	await enforcePlanRunBudget(input.repos, request.planRun, request.child, limits, now);
	return limits;
}
