import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

// warren-f110: the attention panel used dark ink on a dark warning tint.
const { fixture, cases } = harnessCases();
const REASON = "Реальное восстановление и независимый пересчёт остаются невыполненными.";

for (const c of cases.filter((entry) => entry.page.id === "overview")) {
	test.describe(`attention contrast ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("keeps the blocker and title readable on the tinted alert", async ({ page }) => {
			const response = await page.request.get(
				`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
				{ headers: { Authorization: `Bearer ${fixture.token}` } },
			);
			const detail = (await response.json()) as PlanRunDetailResponse;
			const child = detail.children[0];
			if (!child) throw new Error("Missing plan child fixture");
			detail.planRun.state = "running";
			detail.children = [
				{
					...child,
					title: "Восстановление резервной копии",
					state: "pr_open",
					prMergedAt: null,
					reviewStage: "needs_attention",
					reviewSteps: [
						{
							runId: "run_review",
							step: "review",
							executionState: "succeeded",
							summary: {
								status: "changes_requested",
								verdict: "CHANGES",
								qualityGate: "PASS",
								reviewedCommit: null,
								reason: REASON,
							},
						},
					],
					reviewFailure: REASON,
				},
			];
			await page.route(/\/runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { runs: [], total: 0, limit: 200, offset: 0 } }),
			);
			await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { planRuns: [detail.planRun] } }),
			);
			await page.route(`**/plan-runs/${detail.planRun.id}`, (route) =>
				route.fulfill({ json: detail }),
			);
			await openCase(page, c, fixture);
			await page
				.getByRole("button", { name: /Восстановление резервной копии/ })
				.first()
				.click();
			const alert = page.getByRole("dialog").getByRole("alert").filter({ hasText: "Требует тебя" });
			await expect(alert.getByText(REASON, { exact: true })).toBeVisible();
			await expect(alert.getByText("Требует тебя", { exact: true })).toBeVisible();
			const result = await new AxeBuilder({ page })
				.include('[role="dialog"] [role="alert"]')
				.withRules(["color-contrast"])
				.analyze();
			expect(result.violations).toEqual([]);
		});
	});
}
