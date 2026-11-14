import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "instance")) {
	test.describe(`factory toolkit ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("checks an update before explicit apply and restores a previous version", async ({
			page,
		}) => {
			let active = "original";
			const applied: string[] = [];
			const versions = ["original", "candidate"].map((version) => ({
				version,
				skillsVersion: "skills",
				createdAt: "2026-01-01",
			}));
			await page.route("**/toolkit", (route) =>
				route.fulfill({ json: { activeVersion: active, versions } }),
			);
			await page.route("**/toolkit/check", (route) =>
				route.fulfill({
					json: {
						candidate: versions[1],
						probes: [{ service: "exa", status: "quota", tools: [] }],
						dependencies: [{ name: "Chrome", available: true }],
					},
				}),
			);
			await page.route("**/toolkit/apply", async (route) => {
				active = route.request().postDataJSON().version;
				applied.push(active);
				await route.fulfill({ json: { activeVersion: active, versions } });
			});
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: "Check available update", exact: true }).click();
			await expect(page.getByText("Chrome: ready", { exact: true })).toBeVisible();
			await expect(page.getByText("exa: quota · 0 tools", { exact: true })).toBeVisible();
			expect(applied).toEqual([]);
			await page.getByRole("button", { name: "Apply checked version", exact: true }).click();
			await expect(page.getByText("Applied version candidate.", { exact: true })).toBeVisible();
			await page.getByText("Previous versions and rollback", { exact: true }).click();
			await page.getByRole("button", { name: "Use this version", exact: true }).click();
			await expect(page.getByText("Applied version original.", { exact: true })).toBeVisible();
			expect(applied).toEqual(["candidate", "original"]);
			expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
				false,
			);
		});
		test("keeps failed checks separate from applied versions", async ({ page }) => {
			await page.route("**/toolkit", (route) =>
				route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Tools unavailable" } },
				}),
			);
			await openCase(page, c, fixture);
			await expect(page.getByText("Could not load shared tools", { exact: true })).toBeVisible();
			await expect(page.getByText("Applied version", { exact: false })).toHaveCount(0);
		});
	});
}
