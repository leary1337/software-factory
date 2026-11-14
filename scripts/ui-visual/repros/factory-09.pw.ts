/** factory-09: standalone work and its human description belong in the task queue. */
import { expect, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`factory-09 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: "wait" });
		});
		test("omits empty-description placeholders from task cards", async ({ page }) => {
			await openCase(page, c, fixture);
			await expect(
				page.getByRole("article").getByText("Description not provided.", { exact: true }),
			).toHaveCount(0);
		});
		test("keeps machine failure reasons in diagnostics", async ({ page }) => {
			await openCase(page, c, fixture);
			await expect(
				page.getByRole("region", { name: "Needs attention", exact: true }),
			).toBeVisible();
			await expect(page.getByText(/Linked run failed \(provider_error\)/)).toHaveCount(0);
		});
		test("shows a standalone task and description without technical prompt expansion", async ({
			page,
		}) => {
			await page.route(/\/plan-runs(?:\?|$)/, (route) => route.fulfill({ json: { planRuns: [] } }));
			await page.route(/\/runs(?:\?|$)/, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				const run = body.runs[0];
				await route.fulfill({
					json: {
						...body,
						total: 1,
						runs: [
							{
								...run,
								prompt: "Make checkout understandable\n\nExplain the delivery date before payment.",
								parentRunId: null,
								retryOf: null,
								seedId: null,
							},
						],
					},
				});
			});
			await openCase(page, c, fixture);
			await expect(page.getByText("Make checkout understandable", { exact: true })).toBeVisible();
			await expect(
				page.getByText("Explain the delivery date before payment.", { exact: true }),
			).toBeVisible();
		});
	});
}

const LEGACY_INSTRUCTIONS =
	"INTERNAL_REPAIR_NOTE: cherry-pick repair commits for tracker-legacy-123; do not rerun the old test.";
const LONG_DESCRIPTION =
	"Explain each result in ordinary language and preserve the complete decision history. "
		.repeat(12)
		.trim();

async function historicalTasks(page: import("@playwright/test").Page) {
	const response = await page.request.get(
		`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
		{
			headers: { Authorization: `Bearer ${fixture.token}` },
		},
	);
	const template = (await response.json()) as PlanRunDetailResponse;
	const child = template.children[0];
	const run = template.runs[0];
	if (!child || !run) throw new Error("Expected fixture task and execution");
	const historical = {
		...template,
		approval: undefined,
		planRun: { ...template.planRun, id: "plnr_historical", state: "failed" },
		children: [
			{ title: "Archived merged task", state: "merged", productionVerification: null },
			{
				title: "Verified old task",
				state: "merged",
				productionVerification: {
					sha: "a".repeat(40),
					environment: "production",
					verifiedAt: fixture.frozenNow,
					checks: { availability: true, version: true, scenario: true },
				},
			},
			{
				title: "Unresolved production incident",
				state: "merged",
				failureReason: "deployment_incident",
				productionVerification: null,
			},
			{
				title: "Current failed task",
				state: "failed",
				failureReason: "linked run failed: provider_error",
				productionVerification: null,
			},
		].map((patch, index) => ({
			...child,
			planRunId: "plnr_historical",
			seq: index + 1,
			seedId: `history-${index}`,
			runId: index === 0 ? "run_legacy" : null,
			reviewStage: null,
			reviewMerge: null,
			reviewSteps: [],
			failureReason: null,
			budget: null,
			...patch,
		})),
		runs: [{ ...run, id: "run_legacy", prompt: LEGACY_INSTRUCTIONS }],
	};
	const active = {
		...template,
		approval: undefined,
		planRun: { ...template.planRun, id: "plnr_active_delivery", state: "running" },
		children: [
			{
				...child,
				planRunId: "plnr_active_delivery",
				seq: 1,
				seedId: "active-release",
				title: "Active release",
				state: "merged",
				failureReason: null,
				reviewStage: null,
				reviewMerge: null,
				productionVerification: null,
				budget: null,
			},
		],
		runs: [],
	};
	const queued = {
		...active,
		planRun: { ...active.planRun, id: "plnr_queued_delivery", state: "queued" },
		children: active.children.map((item) => ({
			...item,
			planRunId: "plnr_queued_delivery",
			seedId: "queued-release",
			title: "Queued release",
		})),
	};
	const plans = [historical, active, queued];
	await page.route(/\/runs(?:\?.*)?$/, (route) => route.fulfill({ json: { runs: [], total: 0 } }));
	await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { planRuns: plans.map((plan) => plan.planRun) } }),
	);
	for (const detail of plans)
		await page.route(`**/plan-runs/${detail.planRun.id}`, (route) =>
			route.fulfill({ json: detail }),
		);
	return { active, run };
}

for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`factory-09 actual history ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: "wait" });
		});
		test("collapses terminal merges and completed work while keeping live delivery and incidents visible", async ({
			page,
		}) => {
			await historicalTasks(page);
			await openCase(page, c, fixture);
			for (const title of ["Earlier tasks", "Completed"]) {
				const history = page
					.getByRole("region", { name: title, exact: true })
					.locator("details")
					.first();
				await expect(history).toHaveCount(1);
				await expect(history).not.toHaveAttribute("open", "");
			}
			await expect(
				page.getByRole("heading", { name: "Archived merged task", exact: true }),
			).not.toBeVisible();
			await expect(
				page.getByRole("heading", { name: "Verified old task", exact: true }),
			).not.toBeVisible();
			const attention = page.getByRole("region", { name: "Needs attention", exact: true });
			await expect(
				attention.getByRole("heading", { name: "Unresolved production incident" }),
			).toBeVisible();
			await expect(attention.getByRole("heading", { name: "Current failed task" })).toBeVisible();
			const waiting = page.getByRole("region", { name: "Waiting", exact: true });
			await expect(waiting.getByRole("heading", { level: 3 })).toHaveText([
				"Active release",
				"Queued release",
			]);
			await page
				.getByRole("region", { name: "Earlier tasks", exact: true })
				.locator("summary")
				.first()
				.click();
			await expect(page.getByRole("region", { name: "Earlier tasks", exact: true })).toContainText(
				"Release not verified",
			);
		});
		test("keeps legacy execution instructions in task details instead of cards", async ({
			page,
		}) => {
			await historicalTasks(page);
			await openCase(page, c, fixture);
			await page.getByRole("searchbox", { name: "Search tasks" }).fill("Archived merged task");
			const card = page
				.getByRole("article")
				.filter({ has: page.getByRole("heading", { name: "Archived merged task" }) });
			await expect(card).toBeVisible();
			await expect(card).not.toContainText("INTERNAL_REPAIR_NOTE");
			await card.getByRole("link", { name: "Open task →", exact: true }).click();
			const instructions = page
				.locator("details")
				.filter({ has: page.getByText("Task instructions", { exact: true }) });
			await instructions.locator("summary").click();
			await expect(instructions).toContainText(LEGACY_INSTRUCTIONS);
		});
		test("keeps standalone descriptions concise while retaining their text", async ({ page }) => {
			const { run } = await historicalTasks(page);
			await page.route(/\/runs(?:\?.*)?$/, (route) =>
				route.fulfill({
					json: {
						runs: [
							{
								...run,
								id: "run_standalone_description",
								agentName: "implementer",
								projectId: fixture.ids.projects.withSeeds.id,
								state: "queued",
								seedId: null,
								retryOf: null,
								parentRunId: null,
								trigger: "manual",
								prompt: `Standalone concise task\n\n${LONG_DESCRIPTION}`,
							},
						],
						total: 1,
					},
				}),
			);
			await openCase(page, c, fixture);
			const card = page
				.getByRole("article")
				.filter({ has: page.getByRole("heading", { name: "Standalone concise task" }) });
			const description = card
				.locator("p")
				.filter({ hasText: "Explain each result in ordinary language" })
				.first();
			await expect(description).toBeVisible();
			expect(
				await description.evaluate((element) => getComputedStyle(element).webkitLineClamp),
			).toBe("3");
			await expect(description).toContainText("preserve the complete decision history");
		});
	});
}
