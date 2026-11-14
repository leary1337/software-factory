/** factory-24/factory-30: recovery is understandable without opening raw event logs. */
import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
async function recoveryTask(page: Page, recovery: unknown) {
	const response = await page.request.get(
		`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
		{
			headers: { Authorization: `Bearer ${fixture.token}` },
		},
	);
	const detail = (await response.json()) as PlanRunDetailResponse;
	const child = detail.children[0];
	if (!child) throw new Error("Expected fixture task");
	const patched = {
		...detail,
		approval: undefined,
		planRun: { ...detail.planRun, state: "failed" },
		children: [{ ...child, title: "Recover checkout delivery", state: "failed", recovery }],
	};
	await page.route(/\/runs(?:\?.*)?$/, (route) => route.fulfill({ json: { runs: [], total: 0 } }));
	await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { planRuns: [patched.planRun] } }),
	);
	await page.route(`**/plan-runs/${detail.planRun.id}`, (route) =>
		route.fulfill({ json: patched }),
	);
}

for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`factory-24-30 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));
		test("shows exhausted environment repair, its cause and next action in the task", async ({
			page,
		}) => {
			await recoveryTask(page, {
				preparation: {
					state: "stopped",
					attempt: 2,
					reason: "Dependency registry connection timed out",
					action: "Check the dependency registry connection before resuming.",
					stage: "agent",
				},
				rollback: null,
			});
			await openCase(page, c, fixture);
			const card = page.getByRole("article").filter({ hasText: "Recover checkout delivery" });
			await expect(card).toContainText("Environment repair stopped");
			await expect(card).toContainText("2 repair attempts used");
			await card.getByRole("link", { name: "Open task →", exact: true }).click();
			await expect(
				page.getByText("Dependency registry connection timed out", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText("Check the dependency registry connection before resuming.", {
					exact: true,
				}),
			).toBeVisible();
		});
		test("shows verified rollback separately from task completion", async ({ page }) => {
			await recoveryTask(page, {
				preparation: null,
				rollback: {
					state: "verified",
					sha: "a".repeat(40),
					reason: "The new release failed its browser check",
				},
			});
			await openCase(page, c, fixture);
			const card = page.getByRole("article").filter({ hasText: "Recover checkout delivery" });
			await expect(card).toContainText("Previous release restored and verified");
			await card.getByRole("link", { name: "Open task →", exact: true }).click();
			await expect(
				page.getByText("The new release failed its browser check", { exact: true }),
			).toBeVisible();
			await expect(
				page.getByText("The task still needs repair and a verified release.", { exact: true }),
			).toBeVisible();
		});
		test("shows a failed rollback as requiring intervention", async ({ page }) => {
			await recoveryTask(page, {
				preparation: null,
				rollback: {
					state: "failed",
					sha: "a".repeat(40),
					reason: "Previous release health check failed",
				},
			});
			await openCase(page, c, fixture);
			const card = page.getByRole("article").filter({ hasText: "Recover checkout delivery" });
			await expect(card).toContainText("Rollback stopped — action required");
			await card.getByRole("link", { name: "Open task →", exact: true }).click();
			await expect(
				page.getByText("Previous release health check failed", { exact: true }),
			).toBeVisible();
		});
	});
}
