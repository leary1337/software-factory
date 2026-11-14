import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`factory task states ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("shows loading and empty state without inventing task results", async ({ page }) => {
			await page.route(/\/plan-runs(?:\?.*)?$/, async (route) => {
				await new Promise((resolve) => setTimeout(resolve, 1200));
				await route.fulfill({ json: { planRuns: [] } });
			});
			await page.route(/\/runs(?:\?.*)?$/, async (route) =>
				route.fulfill({ json: { runs: [], total: 0 } }),
			);
			const opening = openCase(page, c, fixture);
			await expect(page.getByText("Loading tasks", { exact: true })).toBeVisible();
			await opening;
			await expect(page.getByText("No tasks to show", { exact: false })).toBeVisible();
			expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
				false,
			);
		});
		test("reports connection loss and reloads the same queue without mutations", async ({
			page,
			context,
		}) => {
			const mutations: string[] = [];
			page.on("request", (request) => {
				if (request.method() !== "GET") mutations.push(request.url());
			});
			await openCase(page, c, fixture);
			await context.setOffline(true);
			await expect(page.getByText("Connection interrupted", { exact: true })).toBeVisible();
			await context.setOffline(false);
			await expect(page.getByText("Connection interrupted", { exact: true })).toHaveCount(0);
			await page.reload();
			await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
			expect(mutations).toEqual([]);
		});
		test("shows task read errors without claiming a successful empty queue", async ({ page }) => {
			await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
				route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Task store unavailable" } },
				}),
			);
			await openCase(page, c, fixture);
			await expect(page.getByText("Could not load tasks", { exact: true })).toBeVisible();
			await expect(page.getByText("No tasks to show", { exact: false })).toHaveCount(0);
		});
	});
}
