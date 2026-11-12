import { expect, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

// warren-f108: a review dispatch failure leaves an active plan with no recovery action.
const { fixture, cases } = harnessCases();

for (const c of cases.filter((entry) => ["plan-run-detail", "overview"].includes(entry.page.id))) {
	test.describe(`review recovery ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("retries a review that never started without restarting implementation", async ({
			page,
		}) => {
			const response = await page.request.get(
				`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
				{ headers: { Authorization: `Bearer ${fixture.token}` } },
			);
			const detail = (await response.json()) as PlanRunDetailResponse;
			const child = detail.children[0];
			if (!child) throw new Error("Missing plan child fixture");
			detail.planRun.state = "running";
			detail.planRun.agentName = "implementer";
			detail.children = [
				{
					...child,
					title: "Recover failed review",
					state: "pr_open",
					reviewStage: "needs_attention",
					reviewSteps: [],
					reviewFailure: "Configure qualityGate on the base branch.",
				},
			];
			detail.runs = detail.runs.filter((run) => run.id === child.runId);
			await page.route(/\/runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { runs: [], total: 0, limit: 200, offset: 0 } }),
			);
			let retries = 0;
			await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { planRuns: [detail.planRun] } }),
			);
			await page.route(`**/plan-runs/${detail.planRun.id}`, (route) =>
				route.fulfill({ json: detail }),
			);
			await page.route(
				`**/plan-runs/${detail.planRun.id}/children/${child.seq}/retry-review`,
				async (route) => {
					expect(route.request().method()).toBe("POST");
					retries++;
					detail.children = detail.children.map((entry) => ({
						...entry,
						reviewStage: "reviewing",
					}));
					await route.fulfill({ json: { requested: true } });
				},
			);
			await openCase(
				page,
				c.page.id === "overview" ? c : { ...c, url: `${c.url}?task=${child.seq}` },
				fixture,
			);
			if (c.page.id === "overview")
				await page
					.getByRole("button", { name: /Recover failed review/ })
					.first()
					.click();
			await expect(
				page.getByText("Configure qualityGate on the base branch.", { exact: true }),
			).toBeVisible();
			const retry = page.getByRole("button", { name: "Retry review", exact: true });
			await expect(retry).toBeEnabled();
			await retry.click();
			await expect.poll(() => retries).toBe(1);
			await expect(retry).toHaveCount(0);
		});
	});
}
