/** factory-09: standalone work and its human description belong in the task queue. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`factory-09 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("omits empty-description placeholders from task cards", async ({ page }) => {
			await openCase(page, c, fixture);
			await expect(
				page.getByRole("article").getByText("Description not provided.", { exact: true }),
			).toHaveCount(0);
		});
		test("keeps machine failure reasons in diagnostics", async ({ page }) => {
			await openCase(page, c, fixture);
			await expect(
				page.getByRole("region", { name: "Needs attention", exact: true }),
			).toBeVisible();
			await expect(page.getByText(/Linked run failed \(provider_error\)/)).toHaveCount(0);
		});
		test("shows a standalone task and description without technical prompt expansion", async ({
			page,
		}) => {
			await page.route(/\/plan-runs(?:\?|$)/, (route) => route.fulfill({ json: { planRuns: [] } }));
			await page.route(/\/runs(?:\?|$)/, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				const run = body.runs[0];
				await route.fulfill({
					json: {
						...body,
						total: 1,
						runs: [
							{
								...run,
								prompt: "Make checkout understandable\n\nExplain the delivery date before payment.",
								parentRunId: null,
								retryOf: null,
								seedId: null,
							},
						],
					},
				});
			});
			await openCase(page, c, fixture);
			await expect(page.getByText("Make checkout understandable", { exact: true })).toBeVisible();
			await expect(
				page.getByText("Explain the delivery date before payment.", { exact: true }),
			).toBeVisible();
		});
	});
}
