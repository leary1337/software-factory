import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

// warren-f103: navigation context, delivery status and the actual merge blocker.
const { fixture, cases } = harnessCases();
const TITLE = "Workout rest timer";
const BLOCKER = "Automatic merge was refused because protected files changed.";
const NEXT = "Review the named files before merging the pull request manually.";
const LABEL = "Awaiting merge decision";

async function installBlockedPlan(page: Page) {
	const response = await page.request.get(
		`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
		{
			headers: { Authorization: `Bearer ${fixture.token}` },
		},
	);
	const detail = (await response.json()) as PlanRunDetailResponse;
	const template = detail.children[0];
	if (!template) throw new Error("Missing fixture task");
	detail.planRun.state = "running";
	detail.planRun.planName = "Workout reliability";
	detail.children = Array.from({ length: 12 }, (_, index) => ({
		...template,
		seq: index + 1,
		seedId: `workout-${index + 1}`,
		title: index === 6 ? TITLE : `Workout step ${index + 1}`,
		state: index < 6 ? "merged" : index === 6 ? "pr_open" : "pending",
		prMergedAt: index < 6 ? fixture.frozenNow : null,
		reviewStage: index === 6 ? "needs_attention" : null,
		failureReason: null,
		budget: null,
		reviewMerge:
			index === 6
				? {
						kind: "blocked",
						reason: "protected_path",
						detail: BLOCKER,
						nextAction: NEXT,
						paths: ["scripts/check.sh", "scripts/workout-rest-smoke.mjs"],
					}
				: null,
		reviewSteps: [
			{
				runId: fixture.ids.runs.succeeded,
				step: "review",
				executionState: "succeeded",
				summary: {
					status: "passed",
					verdict: "PASS",
					qualityGate: "PASS",
					gateVerified: true,
					reviewedCommit: "a".repeat(40),
					reason: `No blocking review findings. ${"Review verification details. ".repeat(80)}`,
				},
			},
		],
	}));
	await page.route("**/plan-runs", (route) =>
		route.fulfill({ json: { planRuns: [detail.planRun] } }),
	);
	await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, (route) =>
		route.fulfill({ json: detail }),
	);
	return detail;
}

for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`warren-f103 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.beforeEach(async ({ page }) => {
			await installBlockedPlan(page);
		});

		test("opens task details at the top and restores the plan position on browser back", async ({
			page,
		}) => {
			await openCase(page, { ...c, url: `/#/plan-runs/${fixture.ids.planRun.id}` }, fixture);
			const link = page
				.getByRole("region", { name: "Plan tasks", exact: true })
				.getByRole("link", { name: TITLE, exact: true });
			await link.scrollIntoViewIfNeeded();
			const main = page.locator("main");
			const before = await main.evaluate((element) => element.scrollTop);
			expect(before).toBeGreaterThan(100);
			await link.click();
			await expect(page.getByRole("heading", { name: TITLE, exact: true })).toBeInViewport();
			await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0);
			await page.goBack();
			await expect
				.poll(() => main.evaluate((element) => Math.abs(element.scrollTop - before)))
				.toBeLessThan(3);
		});

		test("keeps task search when returning from details and reloading the list", async ({
			page,
		}) => {
			await openCase(page, c, fixture);
			await page.getByRole("searchbox", { name: "Search tasks" }).fill(TITLE);
			await page.getByRole("link", { name: TITLE, exact: true }).click();
			await page.getByRole("link", { name: "All tasks", exact: true }).click();
			await expect(page.getByRole("searchbox", { name: "Search tasks" })).toHaveValue(TITLE);
			await expect(page.getByRole("heading", { name: "Workout step 8", exact: true })).toHaveCount(
				0,
			);
			await page.reload();
			await expect(page.getByRole("searchbox", { name: "Search tasks" })).toHaveValue(TITLE);
		});

		test("uses the delivery phase and the same waiting status on tasks and plans", async ({
			page,
		}) => {
			await openCase(page, c, fixture);
			const card = page
				.getByRole("article")
				.filter({ has: page.getByRole("heading", { name: TITLE, exact: true }) });
			await expect(card.getByText(LABEL, { exact: true })).toBeVisible();
			await expect(card.locator('[aria-current="step"]')).toHaveText("Delivery");
			await card.getByRole("link", { name: TITLE, exact: true }).click();
			await expect(page.getByText(LABEL, { exact: true })).toBeVisible();
			await expect(page.locator('[aria-current="step"]')).toHaveText("Delivery");
			await page.getByRole("link", { name: "← Back to plan", exact: true }).click();
			await expect(page.locator("main > div > header")).toContainText(LABEL);
			await page.goto(`${fixture.baseUrl}/#/plan-runs`);
			await expect(page.getByRole("article").getByText(LABEL, { exact: true })).toBeVisible();
		});

		test("shows the merge reason and files immediately and avoids duplicate warnings", async ({
			page,
		}) => {
			await openCase(page, c, fixture);
			const card = page
				.getByRole("article")
				.filter({ has: page.getByRole("heading", { name: TITLE, exact: true }) });
			await expect(card).toContainText(BLOCKER);
			await expect(card).toContainText("scripts/check.sh");
			await expect(card).not.toContainText("No blocking review findings.");
			await card.getByRole("link", { name: TITLE, exact: true }).click();
			await expect(page.getByText(NEXT, { exact: true })).toHaveCount(1);
			await expect(page.getByText(BLOCKER, { exact: true })).toHaveCount(1);
		});
	});
}
