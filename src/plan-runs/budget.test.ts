import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlanRunBudgetConfig } from "../core/plan-run-budget.ts";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";
import { createWarrenConfigCache } from "../warren-config/index.ts";
import { parseDefaultsConfig } from "../warren-config/schema.ts";
import { enforcePlanRunBudget, loadPlanRunBudgets, PlanRunBudgetExceededError } from "./budget.ts";
import { preparePlanRunBudget } from "./budget-dispatch.ts";
import { loadPlanRunBudgetView, recordPlanRunBudgetPolicy } from "./budget-policy.ts";
import type { CreatePlanRunSpawnInput } from "./dispatch.ts";
import { createPlanRunSpawn } from "./dispatch.ts";

const NOW = new Date("2026-11-11T00:01:00Z");
describe("plan run budgets", () => {
	let db: WarrenDb;
	let repos: Repos;
	let plan: PlanRunRow;
	let child: PlanRunChildRow;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/test/budget",
			localPath: "/tmp/budget",
			defaultBranch: "main",
		});
		const created = await repos.planRuns.create({
			projectId: project.id,
			agentName: "implementer",
			children: [
				{ seq: 1, seedId: "first" },
				{ seq: 2, seedId: "second" },
			],
		});
		plan = created.planRun;
		const first = created.children[0];
		if (!first) throw new Error("missing child");
		child = first;
	});
	afterEach(async () => {
		await db.close();
	});
	async function run(id: string, cost: number | null = 1) {
		await repos.runs.create({
			id,
			projectId: plan.projectId,
			agentName: "implementer",
			prompt: "work",
			renderedAgentJson: {},
			trigger: "plan-run",
			now: new Date(NOW.getTime() - 10000),
		});
		await repos.runs.markRunning(id, new Date(NOW.getTime() - 10000));
		await repos.runs.finalize(id, "succeeded", NOW);
		await repos.runs.attachStats(id, { costUsd: cost });
		return id;
	}
	async function event(runId: string, kind: string, payload: Record<string, unknown>) {
		await repos.events.append({
			runId,
			kind,
			stream: "system",
			payload,
			ts: NOW.toISOString(),
			sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
		});
	}
	async function implementation() {
		child = await repos.planRuns.updateChild({
			planRunId: plan.id,
			seq: 1,
			patch: { state: "dispatched", runId: await run("impl") },
		});
	}
	test("counts implementation, reviews, rework and prior retries after restart", async () => {
		await implementation();
		for (const id of ["review", "rework", "prior"]) await run(id);
		await event("impl", "plan_run.review_step", { step: "review", stepRunId: "review" });
		await event("impl", "plan_run.review_step", { step: "rework", stepRunId: "rework" });
		await event("impl", "plan_run.child_retried", { previousRunId: "prior" });
		const restartedRepos = createRepos(db);
		const limits = { task: { maxRuns: 4 } };
		await expect(
			enforcePlanRunBudget(restartedRepos, plan, child, limits, NOW),
		).rejects.toBeInstanceOf(PlanRunBudgetExceededError);
		await expect(
			enforcePlanRunBudget(restartedRepos, plan, child, limits, NOW),
		).rejects.toBeInstanceOf(PlanRunBudgetExceededError);
		const events = await repos.events.listByRun("impl");
		expect(events.filter((entry) => entry.kind === "plan_run.budget_blocked")).toHaveLength(1);
	});
	test("applies the whole-plan cap before the next untouched child", async () => {
		await implementation();
		const next = (await repos.planRuns.listChildren(plan.id))[1];
		if (!next) throw new Error("missing next child");
		await expect(
			enforcePlanRunBudget(repos, plan, next, { plan: { maxRuns: 1 } }, NOW),
		).rejects.toThrow("Plan run budget reached");
		const view = await loadPlanRunBudgets(repos, plan, { plan: { maxRuns: 1 } }, NOW.getTime());
		expect(view.get(2)?.task.runs).toBe(0);
		expect(view.get(2)?.plan.runs).toBe(1);
	});
	test("enforces aggregate time and priced estimates and refuses unknown cost", async () => {
		await implementation();
		await expect(
			enforcePlanRunBudget(repos, plan, child, { task: { maxActiveMs: 10000 } }, NOW),
		).rejects.toThrow("active-time budget reached");
		await expect(
			enforcePlanRunBudget(repos, plan, child, { task: { maxCostUsd: 1 } }, NOW),
		).rejects.toThrow("estimated-cost budget reached");
		await repos.runs.attachStats("impl", { costUsd: null });
		await expect(
			enforcePlanRunBudget(repos, plan, child, { task: { maxCostUsd: 100 } }, NOW),
		).rejects.toThrow("cost is unknown");
		await enforcePlanRunBudget(repos, plan, child, { task: { maxRuns: 2 } }, NOW);
	});
	test("distinguishes a reached threshold from a refused dispatch and clears it after admission", async () => {
		await implementation();
		const limits = { task: { maxRuns: 1 } };
		await recordPlanRunBudgetPolicy(repos, plan.id, "impl", limits, NOW);
		expect((await loadPlanRunBudgetView(repos, plan)).get(1)?.awaitingDispatch).toBe(false);
		await expect(enforcePlanRunBudget(repos, plan, child, limits, NOW)).rejects.toThrow();
		expect((await loadPlanRunBudgetView(repos, plan)).get(1)?.awaitingDispatch).toBe(true);
		await event("impl", "plan_run.budget_admitted", { childSeq: 1 });
		expect((await loadPlanRunBudgetView(repos, plan)).get(1)?.awaitingDispatch).toBe(false);
	});
	test("keeps remote enforcement after an agent removes the cached hint and accepts an approved increase", async () => {
		await implementation();
		await recordPlanRunBudgetPolicy(repos, plan.id, "impl", { task: { maxRuns: 1 } }, NOW);
		let approved: PlanRunBudgetConfig = { task: { maxRuns: 1 } };
		const input = {
			repos,
			now: () => NOW,
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					defaults: {},
					triggers: null,
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
			}),
			readApprovedBudgetDefaults: async () => ({ planRunBudget: approved }),
		} as unknown as CreatePlanRunSpawnInput;
		const project = await repos.projects.require(plan.projectId);
		await expect(
			preparePlanRunBudget(input, { planRun: plan, child }, project, undefined),
		).rejects.toThrow("run budget reached");
		approved = { task: { maxRuns: 2 } };
		await expect(
			preparePlanRunBudget(input, { planRun: plan, child }, project, undefined),
		).resolves.toEqual(approved);
		expect((await loadPlanRunBudgetView(repos, plan)).get(1)?.task.runs).toBe(1);
	});
	test("rejects invalid limits without making zero an unlimited budget", () => {
		for (const maxRuns of [0, -1, 1.5, "3"])
			expect(parseDefaultsConfig({ planRunBudget: { task: { maxRuns } } }).ok).toBe(false);
		expect(
			parseDefaultsConfig({
				planRunBudget: { task: { maxRuns: 3 }, plan: { maxCostUsd: 20, maxActiveMs: 60000 } },
			}).ok,
		).toBe(true);
	});
	test("refuses implementation, cold review and rework before calling the runtime", async () => {
		await implementation();
		let spawned = 0;
		const limits = { task: { maxRuns: 1 } };
		const input = {
			repos,
			now: () => NOW,
			warrenConfigs: createWarrenConfigCache({
				load: async () => ({
					defaults: { planRunBudget: limits },
					triggers: null,
					prTemplate: null,
					sourceFile: null,
					errors: [],
					warnings: [],
				}),
			}),
			readApprovedBudgetDefaults: async () => ({ planRunBudget: limits }),
			spawnRunFn: async () => {
				spawned += 1;
				throw new Error("runtime must not be called");
			},
		} as unknown as CreatePlanRunSpawnInput;
		const spawn = createPlanRunSpawn(input);
		for (const agentName of ["implementer", "reviewer", "rework"])
			await expect(
				spawn({ planRun: plan, child, prompt: "work", agentName }),
			).rejects.toBeInstanceOf(PlanRunBudgetExceededError);
		expect(spawned).toBe(0);
	});
});
