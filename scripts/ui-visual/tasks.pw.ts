import { expect, test } from "@playwright/test";
import { harnessCases, openCase, screenshotCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`task workspace ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("follows one task from the list into its complete history", async ({ page }, info) => {
			await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				Object.assign(body.children[0], {
					title: "Keep exercise history",
					reviewStage: "needs_attention",
					state: "pr_open",
					prMergedAt: null,
					endedAt: null,
				});
				body.children[0].metrics = {
					...body.children[0].metrics,
					tokenUnknownRuns: 2,
					incomplete: false,
				};
				body.children[0].reviewMerge = {
					kind: "blocked",
					reason: "protected_path",
					detail: "A protected migration changed.",
					nextAction: "Review the migration manually.",
				};
				body.children[0].reviewSteps = [
					{
						runId: body.runs[0].id,
						step: "review",
						executionState: "succeeded",
						summary: {
							status: "passed",
							verdict: "PASS",
							qualityGate: "PASS",
							reviewedCommit: "a".repeat(40),
							gateVerified: true,
							reason: null,
							acceptance: {
								commit: "a".repeat(40),
								verified: false,
								enforced: false,
								criteria: [
									{
										criterion: "The history stays readable on a phone",
										checkId: null,
										commit: "a".repeat(40),
										result: "NOT_RUN",
										command: null,
										browser: false,
										exitCode: null,
										reason: "No approved check is linked to this criterion.",
										artifacts: [],
									},
								],
							},
						},
					},
				];
				await route.fulfill({ response, json: body });
			});
			await openCase(page, c, fixture);
			await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
			const attention = page.getByRole("region", { name: "Needs attention", exact: true });
			await expect(attention.getByRole("link", { name: "Keep exercise history" })).toBeVisible();
			await page.getByRole("searchbox", { name: "Search tasks" }).fill("Keep exercise");
			await screenshotCase(page, c, info);
			await attention.getByRole("link", { name: "Keep exercise history" }).click();
			await expect(page.getByRole("heading", { name: "Execution history" })).toBeVisible();
			await expect(page.getByText("Action required", { exact: true })).toBeVisible();
			await expect(page.getByText("A protected migration changed.", { exact: true })).toBeVisible();
			await page.getByText("Report for Review 1", { exact: true }).press("Enter");
			await expect(
				page.getByText("The history stays readable on a phone", { exact: true }),
			).toBeVisible();
			await expect(page.getByText("Not verified", { exact: true })).toBeVisible();
			await page.getByText("Task totals", { exact: true }).click();
			await expect(
				page.getByText(/Partial totals. Unknown measurements: tokens for 2 runs/),
			).toBeVisible();
			await page.unrouteAll({ behavior: "wait" });
		});
		test("shows empty and failed inventory with an explicit retry", async ({ page }) => {
			await page.route(/\/runs(?:\?.*)?$/, (route) =>
				route.fulfill({ json: { runs: [], total: 0 } }),
			);
			await page.route("**/plan-runs", (route) => route.fulfill({ json: { planRuns: [] } }));
			await openCase(page, c, fixture);
			await expect(page.getByText("No tasks to show", { exact: true })).toBeVisible();
			await page.unroute("**/plan-runs");
			await page.route("**/plan-runs", (route) =>
				route.fulfill({ status: 500, json: { error: "unavailable" } }),
			);
			await page.reload();
			await expect(page.getByText("Could not load tasks", { exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
			await page.unrouteAll({ behavior: "wait" });
		});
	});
}
