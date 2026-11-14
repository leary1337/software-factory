/** factory-12: project controls must fit the phone's main scroll container. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter(
	(entry) => entry.page.id === "project-detail" && entry.viewport === "phone",
)) {
	test.describe(`factory-12 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("keeps project settings inside the phone viewport", async ({ page }) => {
			await openCase(page, c, fixture);
			await expect(
				page.getByRole("region", { name: "Project settings", exact: true }),
			).toBeVisible();
			expect(
				await page.locator("main").evaluate((element) => element.scrollWidth - element.clientWidth),
			).toBeLessThanOrEqual(1);
		});
	});
}
