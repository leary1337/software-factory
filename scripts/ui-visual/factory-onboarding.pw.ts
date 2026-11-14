import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "project-detail")) {
	test.describe(`factory readiness ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("checks readiness and links the setup proposal without automatic deployment", async ({
			page,
		}) => {
			const mutations: string[] = [];
			await page.route("**/projects/*/readiness", (route) =>
				route.fulfill({
					json: {
						ready: false,
						stale: false,
						fingerprint: "initial",
						checks: [
							{ name: "Project checks", ok: false, message: "Quality gate needs a command" },
						],
					},
				}),
			);
			await page.route("**/projects/*/readiness/check", (route) => {
				mutations.push("check");
				return route.fulfill({
					json: {
						ready: true,
						stale: false,
						fingerprint: "checked",
						checks: [
							{ name: "Project checks", ok: true, message: "Preparation and checks passed" },
						],
					},
				});
			});
			await page.route("**/projects/*/setup-pr", (route) => {
				mutations.push("setup");
				return route.fulfill({
					json: {
						url: "https://github.com/example/repository/pull/1",
						branch: "factory-setup",
						changed: true,
					},
				});
			});
			await openCase(page, c, fixture);
			const region = page.getByRole("region", { name: "Project readiness", exact: true });
			await expect(region.getByText("Setup needs attention", { exact: true })).toBeVisible();
			await region.getByRole("button", { name: "Propose setup changes", exact: true }).click();
			await expect(
				region.getByRole("link", { name: "Open setup proposal ↗", exact: true }),
			).toHaveAttribute("href", "https://github.com/example/repository/pull/1");
			await region.getByRole("button", { name: "Check project readiness", exact: true }).click();
			await expect(
				region.getByText("Ready to start approved plans", { exact: true }),
			).toBeVisible();
			expect(mutations).toEqual(["setup", "check"]);
		});
	});
}
for (const c of cases.filter((entry) => entry.page.id === "projects")) {
	test.describe(`factory new project ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("requires explicit template choice and previews creation before confirmation", async ({
			page,
		}) => {
			let previews = 0;
			let creates = 0;
			await page.route("**/projects/new/preview", (route) => {
				previews++;
				const request = route.request().postDataJSON();
				return route.fulfill({
					json: {
						request,
						repository: `${request.owner}/${request.name}`,
						stack: ["Go", "React"],
						settings: {},
						confirmation: "checked-choice",
						deliveryConfigured: false,
					},
				});
			});
			await page.route("**/projects/new", (route) => {
				creates++;
				expect(route.request().postDataJSON().confirmation).toBe("checked-choice");
				return route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Repository creation unavailable" } },
				});
			});
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: "＋ Add project", exact: true }).click();
			await page.getByText("Create a new project", { exact: true }).click();
			await page.getByLabel("GitHub owner or organization", { exact: true }).fill("example");
			await page.getByLabel("New repository name", { exact: true }).fill("my-app");
			await expect(
				page.getByRole("button", { name: "Preview new project", exact: true }),
			).toBeDisabled();
			await page
				.getByRole("combobox", { name: "Project template", exact: true })
				.selectOption("go-react");
			await page.getByRole("button", { name: "Preview new project", exact: true }).click();
			await expect(page.getByText("example/my-app", { exact: true })).toBeVisible();
			expect(previews).toBe(1);
			expect(creates).toBe(0);
			await page.getByRole("button", { name: "Create this project", exact: true }).click();
			await expect(
				page.getByText("Project creation did not complete", { exact: true }),
			).toBeVisible();
			expect(creates).toBe(1);
		});
	});
}
