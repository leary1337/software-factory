/** warren-f009: the scrolling console main must accept keyboard focus. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "agents" && entry.viewport === "phone")) {
	test.describe(`warren-f009 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("lets keyboard users focus the scrolling content region", async ({ page }) => {
			await openCase(page, c, fixture);
			const result = await new AxeBuilder({ page })
				.include("main")
				.withRules(["scrollable-region-focusable"])
				.analyze();
			expect(result.violations.map((violation) => violation.id)).toEqual([]);
		});
	});
}
