import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { harnessCases, openCase, screenshotCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "plan-run-detail")) {
	test.describe(`production incident ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("shows incident evidence and explicitly resumes verification", async ({ page }, info) => {
			let resumed = false;
			await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.planRun.state = resumed ? "running" : "failed";
				body.planRun.failureReason = resumed ? null : "deployment_incident";
				Object.assign(body.children[0], {
					title: "Deliver production",
					state: resumed ? "pr_open" : "failed",
					failureReason: resumed ? null : "deployment_incident",
				});
				await route.fulfill({ response, json: body });
			});
			await page.route("**/runs/*/events", (route) =>
				route.fulfill({
					contentType: "application/x-ndjson",
					body: `${JSON.stringify({ seq: 1, kind: "plan_run.deployment_incident", payload: { reason: "Production smoke returned HTTP 503" } })}\n`,
				}),
			);
			await page.route(`**/plan-runs/${fixture.ids.planRun.id}/resume`, async (route) => {
				expect(route.request().method()).toBe("POST");
				resumed = true;
				await route.fulfill({ json: { resumed: true } });
			});
			await openCase(page, c, fixture);
			await page
				.getByRole("region", { name: "Plan progress", exact: true })
				.getByRole("link", { name: "Deliver production", exact: true })
				.click();
			await expect(page.getByText("Production needs attention", { exact: true })).toBeVisible();
			await expect(
				page.getByText("Production smoke returned HTTP 503", { exact: true }),
			).toBeVisible();
			const button = page.getByRole("button", { name: "Recheck production and resume" });
			await expect(button).toBeVisible();
			const widths = await page.evaluate(() => ({
				actual: document.documentElement.scrollWidth,
				viewport: innerWidth,
			}));
			expect(widths.actual).toBeLessThanOrEqual(widths.viewport);
			const contrast = await new AxeBuilder({ page })
				.include("main")
				.withRules(["color-contrast"])
				.analyze();
			expect(contrast.violations.map((violation) => violation.id)).toEqual([]);
			await screenshotCase(
				page,
				{ ...c, name: c.name.replace("plan-run-detail", "production-incident") },
				info,
			);
			await button.click();
			await expect(button).not.toBeVisible();
			expect(resumed).toBe(true);
			await page.unrouteAll({ behavior: "wait" });
		});
	});
}
