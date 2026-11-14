/** factory-11: ordinary navigation has exactly Tasks, Projects and Settings. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`factory-11 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("keeps technical screens out of ordinary navigation", async ({ page }) => {
			await openCase(page, c, fixture);
			const nav = page.getByRole("navigation", {
				name: c.size.width < 768 ? "Primary" : "Workspace",
				exact: true,
			});
			await expect(nav.getByRole("link")).toHaveText(["Tasks", "Projects", "Settings"]);
			await expect(nav.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
		});
	});
}
