/** warren-f008: show production loading, failure and unknown release states. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();

for (const c of cases.filter((entry) => entry.page.id === "project-detail")) {
	test.describe(`factory-production ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });

		test("shows unconfigured production and keeps it inside the viewport", async ({ page }) => {
			await page.route("**/projects/*/deploy", (route) =>
				route.fulfill({ json: { configured: false } }),
			);
			await openCase(page, c, fixture);
			const panel = page.getByRole("region", { name: "Production", exact: true });
			await expect(panel).toBeVisible();
			await expect(panel).toContainText("Deploy для этого проекта не настроен");
			const box = await panel.boundingBox();
			expect(box).not.toBeNull();
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(c.size.width);
		});

		test("shows loading and offers retry after a failed load", async ({ page }) => {
			let release: (() => void) | undefined;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/projects/*/deploy", async (route) => {
				await pending;
				await route.fulfill({
					status: 503,
					json: { error: { message: "Deploy lookup unavailable" } },
				});
			});
			const opened = openCase(page, c, fixture);
			try {
				await expect(page.getByText("Загрузка Production…")).toBeVisible();
			} finally {
				release?.();
			}
			await opened;
			const panel = page.getByRole("region", { name: "Production", exact: true });
			await expect(panel.getByRole("button", { name: "Повторить" })).toBeVisible();
			await page.unroute("**/projects/*/deploy");
			await page.route("**/projects/*/deploy", (route) =>
				route.fulfill({ json: { configured: false } }),
			);
			await panel.getByRole("button", { name: "Повторить" }).click();
			await expect(panel).toContainText("Deploy для этого проекта не настроен");
		});

		test("distinguishes unknown production from no release", async ({ page }) => {
			await page.route("**/projects/*/deploy", (route) =>
				route.fulfill({
					json: {
						configured: true,
						workflow: "deploy.yml",
						environment: "production",
						branch: "main",
						current: null,
						currentState: "unknown",
						behind: null,
						activeRun: null,
						history: [],
						activePlan: null,
						error: "Deployment history could not be read.",
					},
				}),
			);
			await openCase(page, c, fixture);
			const panel = page.getByRole("region", { name: "Production", exact: true });
			await expect(panel).toContainText("Текущий Release неизвестен");
			await expect(panel).not.toContainText("Ещё не опубликовано");
			await expect(panel.getByRole("button", { name: "Deploy", exact: true })).toBeDisabled();
		});
	});
}
