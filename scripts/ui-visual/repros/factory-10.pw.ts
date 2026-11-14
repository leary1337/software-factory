/** factory-10 (and factory-09 evidence): projects contain plans, and merge alone is not delivery. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter(
	(entry) => entry.page.id === "tasks" || entry.page.id === "project-detail",
)) {
	test.describe(`factory-10 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		if (c.page.id === "project-detail") {
			test("shows existing plan attempts inside their project", async ({ page }) => {
				await openCase(page, c, fixture);
				await expect(
					page.getByRole("region", { name: "Project plans", exact: true }),
				).toBeVisible();
			});
		} else {
			test.beforeEach(async ({ page }) => {
				await page.route(/\/plan-runs\/[^/?]+$/, async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					const child = body.children[0];
					const run = body.runs[0];
					await route.fulfill({
						json: {
							...body,
							children: [
								{
									...child,
									title: "Make receipts understandable",
									state: "merged",
									runId: run.id,
									productionVerification: null,
								},
							],
							runs: [
								{
									...run,
									prompt: "Make receipts understandable\n\nExplain every charge before payment.",
								},
							],
						},
					});
				});
			});
			test("does not announce delivery without release verification", async ({ page }) => {
				await openCase(page, c, fixture);
				const task = page
					.getByRole("article")
					.filter({ hasText: "Make receipts understandable" })
					.first();
				await expect(task).not.toContainText("The change has been delivered.");
				await expect(task).toContainText("Release not verified");
			});
			test("shows the human task description on the card", async ({ page }) => {
				await openCase(page, c, fixture);
				await expect(
					page.getByText("Explain every charge before payment.", { exact: true }).first(),
				).toBeVisible();
			});
		}
	});
}
