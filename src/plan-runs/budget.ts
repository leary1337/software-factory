import type {
	PlanRunBudgetConfig,
	PlanRunBudgetLimits,
	PlanRunBudgetSummary,
	PlanRunBudgetUsage,
} from "../core/plan-run-budget.ts";
import type { TaskMetrics } from "../core/task-metrics.ts";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";
import { PlanRunSpawnDeferredError } from "./errors.ts";
import { loadTaskMetrics } from "./task-metrics-load.ts";

const NEXT_ACTION =
	"Inspect the task usage. To continue, raise the relevant planRunBudget limit in the project's approved configuration and refresh the project. Existing usage is retained.";

export class PlanRunBudgetExceededError extends PlanRunSpawnDeferredError {
	override readonly code = "plan_run_budget_exhausted";
}

function usage(metrics: readonly TaskMetrics[]): PlanRunBudgetUsage {
	return metrics.reduce<PlanRunBudgetUsage>(
		(sum, value) => ({
			runs: sum.runs + value.runCount,
			activeMs: sum.activeMs + (value.activeMs ?? 0),
			costUsd: sum.costUsd + (value.costUsd ?? 0),
			unknownCostRuns: sum.unknownCostRuns + value.costUnknownRuns,
			unknownDurationRuns: sum.unknownDurationRuns + value.durationUnknownRuns,
			incomplete: sum.incomplete || value.incomplete,
		}),
		{
			runs: 0,
			activeMs: 0,
			costUsd: 0,
			unknownCostRuns: 0,
			unknownDurationRuns: 0,
			incomplete: false,
		},
	);
}

function exceeded(
	scope: string,
	limits: PlanRunBudgetLimits | undefined,
	spent: PlanRunBudgetUsage,
): string | null {
	if (!limits || Object.keys(limits).length === 0) return null;
	if (spent.incomplete)
		return `${scope} usage is incomplete; another dispatch cannot be authorized.`;
	if (limits.maxRuns !== undefined && spent.runs >= limits.maxRuns)
		return `${scope} run budget reached (${spent.runs}/${limits.maxRuns}).`;
	if (limits.maxActiveMs !== undefined) {
		if (spent.unknownDurationRuns > 0)
			return `${scope} execution time is unknown for ${spent.unknownDurationRuns} run(s).`;
		if (spent.activeMs >= limits.maxActiveMs)
			return `${scope} active-time budget reached (${spent.activeMs}/${limits.maxActiveMs} ms).`;
	}
	if (limits.maxCostUsd !== undefined) {
		if (spent.unknownCostRuns > 0)
			return `${scope} cost is unknown for ${spent.unknownCostRuns} run(s).`;
		if (spent.costUsd >= limits.maxCostUsd)
			return `${scope} estimated-cost budget reached (${spent.costUsd}/${limits.maxCostUsd} USD).`;
	}
	return null;
}

export function summarizePlanRunBudget(
	limits: PlanRunBudgetConfig,
	taskMetrics: TaskMetrics,
	allMetrics: readonly TaskMetrics[],
): PlanRunBudgetSummary {
	const task = usage([taskMetrics]);
	const plan = usage(allMetrics);
	const reason = exceeded("Task", limits.task, task) ?? exceeded("Plan", limits.plan, plan);
	return {
		limits,
		task,
		plan,
		blocked: reason !== null,
		awaitingDispatch: false,
		reason,
		nextAction: reason === null ? null : NEXT_ACTION,
	};
}

export async function loadPlanRunBudgets(
	repos: Pick<Repos, "planRuns" | "runs" | "events">,
	planRun: PlanRunRow,
	limits: PlanRunBudgetConfig,
	now = Date.now(),
): Promise<Map<number, PlanRunBudgetSummary>> {
	const children = await repos.planRuns.listChildren(planRun.id);
	const metrics = await Promise.all(
		children.map((child) => loadTaskMetrics(repos, planRun.projectId, child, now)),
	);
	return new Map(
		children.flatMap((child, index) => {
			const task = metrics[index];
			return task ? [[child.seq, summarizePlanRunBudget(limits, task, metrics)] as const] : [];
		}),
	);
}

/** Persist only a changed refusal; repeated ticks never flood the event history. */
export async function enforcePlanRunBudget(
	repos: Pick<Repos, "planRuns" | "runs" | "events">,
	planRun: PlanRunRow,
	child: PlanRunChildRow,
	limits: PlanRunBudgetConfig | undefined,
	now = new Date(),
): Promise<void> {
	if (!limits) return;
	const summary = (await loadPlanRunBudgets(repos, planRun, limits, now.getTime())).get(child.seq);
	if (!summary?.blocked) return;
	const children = await repos.planRuns.listChildren(planRun.id);
	const anchor = child.runId ?? [...children].reverse().find((entry) => entry.runId)?.runId;
	if (anchor) {
		const events = await repos.events.listByRun(anchor);
		const previous = [...events]
			.reverse()
			.find((event) => event.kind === "plan_run.budget_blocked");
		const payload = { planRunId: planRun.id, childSeq: child.seq, ...summary };
		if (JSON.stringify(previous?.payloadJson) !== JSON.stringify(payload)) {
			await repos.events.append({
				runId: anchor,
				sandboxEventSeq: ((await repos.events.maxSeqForRun(anchor)) ?? 0) + 1,
				ts: now.toISOString(),
				kind: "plan_run.budget_blocked",
				stream: "system",
				payload,
			});
		}
	}
	throw new PlanRunBudgetExceededError(summary.reason ?? "Plan budget exhausted");
}
