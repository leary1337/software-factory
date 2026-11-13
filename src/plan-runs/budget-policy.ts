import type { PlanRunBudgetConfig, PlanRunBudgetSummary } from "../core/plan-run-budget.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunRow } from "../db/schema.ts";
import { PlanRunBudgetConfigSchema } from "../warren-config/plan-run-budget-config.ts";
import { loadPlanRunBudgets } from "./budget.ts";

type BudgetRepos = Pick<Repos, "planRuns" | "events">;

export async function loadPlanRunBudgetView(
	repos: Pick<Repos, "planRuns" | "events" | "runs">,
	planRun: PlanRunRow,
): Promise<Map<number, PlanRunBudgetSummary>> {
	const limits = await readPlanRunBudgetPolicy(repos, planRun);
	if (limits === null) return new Map();
	const summaries = await loadPlanRunBudgets(repos, planRun, limits);
	const children = await repos.planRuns.listChildren(planRun.id);
	const events = (
		await Promise.all(
			children.flatMap((child) => (child.runId ? [repos.events.listByRun(child.runId)] : [])),
		)
	)
		.flat()
		.sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id);
	for (const [seq, summary] of summaries) {
		const last = events.find(
			(event) =>
				(event.kind === "plan_run.budget_blocked" || event.kind === "plan_run.budget_admitted") &&
				(event.payloadJson as { childSeq?: unknown }).childSeq === seq,
		);
		summaries.set(seq, {
			...summary,
			awaitingDispatch: summary.blocked && last?.kind === "plan_run.budget_blocked",
		});
	}
	return summaries;
}

/** Find the last control-plane policy, including an explicit removal of limits. */
export async function readPlanRunBudgetPolicy(
	repos: BudgetRepos,
	planRun: PlanRunRow,
): Promise<PlanRunBudgetConfig | null> {
	const children = await repos.planRuns.listChildren(planRun.id);
	const events = (
		await Promise.all(
			children.flatMap((child) => (child.runId ? [repos.events.listByRun(child.runId)] : [])),
		)
	).flat();
	const latest = events
		.filter((event) => event.kind === "plan_run.budget_policy")
		.sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id)[0];
	if (!latest) return null;
	const value = latest.payloadJson as { limits?: unknown; planRunId?: unknown };
	if (value.planRunId !== planRun.id)
		throw new Error("Plan budget policy belongs to another plan.");
	return PlanRunBudgetConfigSchema.parse(value.limits);
}

/** Write only a changed policy. A missing active policy is not permission to reset usage. */
export async function recordPlanRunBudgetPolicy(
	repos: BudgetRepos,
	planRunId: string,
	runId: string,
	limits: PlanRunBudgetConfig,
	now: Date,
): Promise<void> {
	const events = await repos.events.listByRun(runId);
	const previous = [...events].reverse().find((event) => event.kind === "plan_run.budget_policy");
	const payload = { planRunId, limits };
	if (JSON.stringify(previous?.payloadJson) === JSON.stringify(payload)) return;
	await repos.events.append({
		runId,
		sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
		ts: now.toISOString(),
		kind: "plan_run.budget_policy",
		stream: "system",
		payload,
	});
}
