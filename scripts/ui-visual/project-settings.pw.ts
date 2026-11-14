import { expect, test } from "@playwright/test";
import type {
	ProjectSettingsResponse,
	ProjectSettingsUpdate,
} from "../../src/core/project-settings.ts";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
function initialSettings(): ProjectSettingsResponse {
	return {
		revision: 0,
		overrides: {},
		effective: {
			executionProfiles: {
				implementation: { runtime: "codex", model: "gpt-6.1-sol" },
				review: { runtime: "codex", model: "gpt-6.1-sol" },
			},
		},
		executionOptions: [{ runtime: "codex", label: "Codex", defaultModel: "gpt-6.1-sol" }],
		errors: [],
	};
}

for (const c of cases.filter((entry) => entry.page.id === "project-detail")) {
	test.describe(`factory-12 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("saves separate profiles and preparation then reloads the same choices", async ({
			page,
		}) => {
			let settings = initialSettings();
			await page.route("**/projects/*/settings", async (route) => {
				if (route.request().method() === "PATCH") {
					const input = route.request().postDataJSON() as ProjectSettingsUpdate;
					expect(input.revision).toBe(settings.revision);
					settings = {
						...settings,
						revision: settings.revision + 1,
						overrides: { ...settings.overrides, ...input.patch },
						effective: { ...settings.effective, ...input.patch },
					};
				}
				await route.fulfill({ json: settings });
			});
			await openCase(page, c, fixture);
			await page.getByLabel("Executor model", { exact: true }).fill("executor-choice");
			await page.getByLabel("Reviewer model", { exact: true }).fill("reviewer-choice");
			await page
				.getByRole("combobox", { name: "Preparation recipe", exact: true })
				.selectOption("go");
			await page
				.getByRole("combobox", { name: "Verify before merging", exact: true })
				.selectOption("warren");
			await page
				.getByRole("textbox", { name: /Required merge checks \(one per line\)/ })
				.fill("quality");
			await page.getByRole("button", { name: "Save project settings", exact: true }).click();
			await expect(page.getByText("Project settings saved", { exact: true })).toBeVisible();
			expect(settings.effective.executionProfiles.implementation.model).toBe("executor-choice");
			expect(settings.effective.executionProfiles.review.model).toBe("reviewer-choice");
			await page.reload();
			await expect(page.getByLabel("Executor model", { exact: true })).toHaveValue(
				"executor-choice",
			);
			await expect(page.getByLabel("Reviewer model", { exact: true })).toHaveValue(
				"reviewer-choice",
			);
			await expect(
				page.getByRole("combobox", { name: "Preparation recipe", exact: true }),
			).toHaveValue("go");
			await expect(page.getByRole("region", { name: "Project settings" })).toBeVisible();
			await expect(
				page.getByRole("combobox", { name: "Verify before merging", exact: true }),
			).toHaveValue("warren");
			await expect(
				page.getByRole("textbox", { name: /Required merge checks \(one per line\)/ }),
			).toHaveValue("quality");
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
			expect(overflow).toBe(false);
		});
		test("shows loading and defaults when no overrides exist", async ({ page }) => {
			await page.route("**/projects/*/settings", async (route) => {
				await new Promise((resolve) => setTimeout(resolve, 1500));
				await route.fulfill({ json: initialSettings() });
			});
			const opening = openCase(page, c, fixture);
			await expect(page.getByText("Loading execution settings", { exact: true })).toBeVisible();
			await opening;
			await expect(page.getByLabel("Executor model", { exact: true })).toHaveValue("gpt-6.1-sol");
			await expect(page.getByText("Project settings saved", { exact: true })).toHaveCount(0);
		});
		test("does not claim saved choices when settings cannot be read", async ({ page }) => {
			await page.route("**/projects/*/settings", (route) =>
				route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Connection unavailable" } },
				}),
			);
			await openCase(page, c, fixture);
			await expect(
				page.getByText("Could not load execution settings", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Save project settings", exact: true }),
			).toHaveCount(0);
			await expect(page.getByText("Project settings saved", { exact: true })).toHaveCount(0);
		});
	});
}
