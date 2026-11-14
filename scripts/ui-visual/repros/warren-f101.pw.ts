import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase, screenshotCase } from "../harness.ts";

// warren-f101: old plan attempts hide the running task and obscure resumed progress.
const { fixture, cases } = harnessCases();
const TITLE = "Explicit confirmation and rest timer";

async function installAttempts(page: Page) {
	const response = await page.request.get(
		`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
		{
			headers: { Authorization: `Bearer ${fixture.token}` },
		},
	);
	const original = (await response.json()) as PlanRunDetailResponse;
	const template = original.children[0];
	if (!template) throw new Error("Fixture needs a child");
	const active: PlanRunDetailResponse = {
		...original,
		planRun: { ...original.planRun, planName: "Workout reliability", state: "running" as const },
		children: Array.from({ length: 12 }, (_, index) => ({
			...template,
			seq: index + 1,
			seedId: `workout-${index + 1}`,
			title: index === 6 ? TITLE : `Workout step ${index + 1}`,
			state: index < 5 ? "skipped" : index === 5 ? "merged" : index === 6 ? "running" : "pending",
			runId: index === 6 ? fixture.ids.runs.running : null,
			prMergedAt: index === 5 ? fixture.frozenNow : null,
			reviewStage: null,
			reviewSteps: [],
			reviewMerge: null,
			failureReason: null,
			budget: null,
		})),
	};
	const plans: PlanRunDetailResponse[] = [
		active,
		...[1, 2].map((number) => ({
			...active,
			planRun: {
				...active.planRun,
				id: `plnr_oldattempt${number}`,
				state: "cancelled" as const,
				createdAt: new Date(fixture.frozenNowMs - number * 86_400_000).toISOString(),
			},
			children: active.children.map((child) => ({
				...child,
				planRunId: `plnr_oldattempt${number}`,
				state: "pending" as const,
				runId: null,
			})),
		})),
	];
	await page.route("**/plan-runs", (route) =>
		route.fulfill({ json: { planRuns: plans.map((detail) => detail.planRun) } }),
	);
	await page.route("**/plan-runs/*", async (route) => {
		const id = new URL(route.request().url()).pathname.split("/").at(-1);
		const detail = plans.find((entry) => entry.planRun.id === id);
		if (detail) await route.fulfill({ json: detail });
		else await route.continue();
	});
	return active;
}

for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`warren-f101 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		let active: PlanRunDetailResponse;
		test.beforeEach(async ({ page }) => {
			active = await installAttempts(page);
		});

		test("shows one task with its previous attempts", async ({ page }, info) => {
			await openCase(page, c, fixture);
			await page.getByRole("searchbox", { name: "Search tasks" }).fill(TITLE);
			await expect(page.getByRole("heading", { name: TITLE, exact: true })).toHaveCount(1);
			await expect(page.getByRole("region", { name: "Needs attention", exact: true })).toHaveCount(
				0,
			);
			await page.getByText("Attempt history (3)", { exact: true }).click();
			await expect(page.getByRole("link", { name: /Cancelled/ })).toHaveCount(2);
			await screenshotCase(page, { ...c, name: `task-attempts.${c.viewport}.${c.theme}` }, info);
		});

		test("separates delivered work from previously closed tasks", async ({ page }) => {
			await openCase(page, { ...c, url: `/#/plan-runs/${fixture.ids.planRun.id}` }, fixture);
			const progress = page.getByRole("region", { name: "Plan progress", exact: true });
			await expect(progress.getByText("Task 7 of 12", { exact: true })).toBeVisible();
			await expect(progress).toContainText("1 merged · 0 release verified");
			await expect(progress).toContainText("5 previously closed");
			await expect(progress).toContainText("5 waiting");
		});

		test("puts current work first and opens live monitoring inside the task", async ({
			page,
		}, info) => {
			await openCase(page, c, fixture);
			const current = page.getByRole("region", { name: "Current work", exact: true });
			await expect(current.getByRole("heading", { name: TITLE })).toBeInViewport();
			await expect(current.getByRole("link", { name: "Live log" })).toHaveCount(0);
			await current.getByRole("link", { name: TITLE, exact: true }).click();
			await expect(page.getByText("Task 7 of 12", { exact: true })).toBeVisible();
			await expect(page.getByRole("link", { name: "Live log" })).toHaveAttribute(
				"href",
				`#/runs/${fixture.ids.runs.running}`,
			);
			await expect(page.getByText(/Started|Stage running for/)).toBeVisible();
			await screenshotCase(page, { ...c, name: `current-work.${c.viewport}.${c.theme}` }, info);
		});
		test("follows review in task details and keeps merged work waiting for release proof", async ({
			page,
		}) => {
			await openCase(page, c, fixture);
			await page.getByRole("link", { name: TITLE, exact: true }).click();
			const current = page.locator("main");
			await expect(current.getByRole("link", { name: "Live log" })).toHaveAttribute(
				"href",
				`#/runs/${fixture.ids.runs.running}`,
			);
			const child = active.children[6];
			if (!child) throw new Error("Missing current child");
			Object.assign(child, {
				state: "pr_open",
				reviewStage: "reviewing",
				reviewSteps: [
					{
						runId: fixture.ids.runs.succeeded,
						step: "review",
						executionState: "succeeded",
						summary: null,
					},
				],
			});
			await expect(current.getByText("Reviewing", { exact: true })).toBeVisible({ timeout: 10000 });
			await expect(current.getByRole("link", { name: "Live log" })).toHaveAttribute(
				"href",
				`#/runs/${fixture.ids.runs.succeeded}`,
			);
			await expect(
				current.getByText("Execution succeeded. Waiting for the plan to update."),
			).toBeVisible();
			Object.assign(child, { state: "merged", prMergedAt: fixture.frozenNow });
			await expect(page.getByText("Release not verified", { exact: true })).toBeVisible({
				timeout: 10000,
			});
			await page.getByRole("link", { name: "All tasks", exact: true }).click();
			await expect(
				page
					.getByRole("region", { name: "Current work", exact: true })
					.getByRole("heading", { name: TITLE, exact: true }),
			).toHaveCount(0);
			await expect(
				page
					.getByRole("region", { name: "Waiting", exact: true })
					.getByRole("heading", { name: TITLE }),
			).toBeVisible();
			await expect(page.getByRole("heading", { name: TITLE, exact: true })).toHaveCount(1);
		});

		test("retains the last activity on a failed refresh and recovers without reloading", async ({
			page,
		}) => {
			let unavailable = false;
			await page.route("**/events?*", async (route) => {
				if (unavailable) {
					await route.fulfill({ status: 503, json: { error: "unavailable" } });
					return;
				}
				const url = new URL(route.request().url());
				const kind = url.searchParams.get("kind") ?? "tool_end";
				await route.fulfill({
					json: {
						events: [
							{
								id: 1,
								runId: fixture.ids.runs.running,
								seq: 1,
								ts: fixture.frozenNow,
								kind,
								payload: { text: "Checking the rest timer." },
								stream: "stdout",
								origin: null,
							},
						],
						total: 1,
						limit: 1,
						offset: 0,
					},
				});
			});
			await openCase(page, { ...c, url: `/#/plan-runs/${fixture.ids.planRun.id}?task=7` }, fixture);
			const activity = page.getByRole("region", { name: "Current activity", exact: true });
			await expect(activity).toContainText("Checking the rest timer.");
			unavailable = true;
			await expect(activity).toContainText("Showing the last known activity.", { timeout: 10000 });
			await expect(activity).toContainText("Checking the rest timer.");
			await expect(activity).not.toContainText("Loading current activity");
			unavailable = false;
			await activity.getByRole("button", { name: "Retry activity" }).click();
			await expect(activity.getByText(/Live updates unavailable/)).toHaveCount(0);
		});

		test("distinguishes an unavailable activity snapshot from an execution with no events", async ({
			page,
		}) => {
			let unavailable = true;
			await page.route("**/events?*", (route) =>
				route.fulfill(
					unavailable
						? { status: 503, json: { error: "unavailable" } }
						: { json: { events: [], total: 0, limit: 1, offset: 0 } },
				),
			);
			await openCase(page, { ...c, url: `/#/plan-runs/${fixture.ids.planRun.id}?task=7` }, fixture);
			const activity = page.getByRole("region", { name: "Current activity", exact: true });
			await expect(activity).toContainText("Current activity is unknown.");
			await expect(activity).not.toContainText("Loading current activity");
			unavailable = false;
			await activity.getByRole("button", { name: "Retry activity" }).click();
			await expect(activity).toContainText("No events reported yet");
			await expect(activity.getByText(/Live updates unavailable/)).toHaveCount(0);
		});
	});
}
