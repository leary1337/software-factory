/** warren-f114: completed plan deliveries supersede earlier standalone failures. */

import { expect, test } from "@playwright/test";
import type { PlanRunDetailResponse, RunRow } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
const staleTitle = "Старая попытка исправления";
const blockerTitle = "Текущая задача заблокирована";
const hour = 3_600_000;

for (const c of cases.filter((entry) => entry.page.id === "overview")) {
	test.describe(`resolved attempt ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("keeps a resolved crash out of attention while showing a current blocker", async ({
			page,
		}) => {
			const response = await page.request.get(
				`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
				{ headers: { Authorization: `Bearer ${fixture.token}` } },
			);
			const detail = (await response.json()) as PlanRunDetailResponse;
			const child = detail.children[0];
			if (!child) throw new Error("Missing fixture child");
			const now = Date.parse(fixture.frozenNow);
			const past = (hours: number) => new Date(now - hours * hour).toISOString();
			detail.planRun = { ...detail.planRun, state: "cancelled", createdAt: past(6) };
			detail.runs = [];
			detail.children = [
				{
					...child,
					title: "Шаг после успешного слияния",
					state: "merged",
					prMergedAt: past(2),
					endedAt: past(2),
					updatedAt: past(2),
					reviewStage: null,
					productionVerification: null,
				},
			];
			const run = {
				id: "run_old_rework",
				projectId: detail.planRun.projectId,
				seedId: child.seedId,
				createdAt: now - 4 * hour,
				endedAt: past(3),
				state: "failed",
				failureReason: "crashed",
				prompt: staleTitle,
				agentName: "rework",
			} satisfies Partial<RunRow>;
			const activeId = `${detail.planRun.id}-active`;
			const active = {
				planRun: { ...detail.planRun, id: activeId, state: "running", createdAt: past(1) },
				children: [
					{
						...child,
						planRunId: activeId,
						seedId: "current-blocker",
						runId: null,
						title: blockerTitle,
						state: "pr_open",
						prMergedAt: null,
						reviewStage: "needs_attention",
						updatedAt: past(1),
						reviewSteps: [],
					},
				],
				runs: [],
			} satisfies PlanRunDetailResponse;
			await page.route(/\/runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { runs: [run], total: 1 } }),
			);
			await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { planRuns: [active.planRun, detail.planRun] } }),
			);
			await page.route(`**/plan-runs/${detail.planRun.id}`, (route) =>
				route.fulfill({ json: detail }),
			);
			await page.route(`**/plan-runs/${activeId}`, (route) => route.fulfill({ json: active }));
			await openCase(page, c, fixture);
			const attention = page.getByRole("region", { name: "Требует тебя", exact: true });
			await expect(attention.getByRole("button", { name: blockerTitle })).toBeVisible();
			await expect(attention.getByRole("button", { name: staleTitle })).toHaveCount(0);
			await expect(page.getByRole("button", { name: "Шаг после успешного слияния" })).toBeVisible();
		});
	});
}
