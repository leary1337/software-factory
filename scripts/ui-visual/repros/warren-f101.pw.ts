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
	const active = {
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
	const plans = [
		active,
		...[1, 2].map((number) => ({
			...active,
			planRun: {
				...active.planRun,
				id: `plnr_oldattempt${number}`,
				state: "cancelled",
				createdAt: new Date(fixture.frozenNowMs - number * 86_400_000).toISOString(),
			},
			children: active.children.map((child) => ({
				...child,
				planRunId: `plnr_oldattempt${number}`,
				state: "pending",
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
}

for (const c of cases.filter((entry) => entry.page.id === "tasks")) {
	test.describe(`warren-f101 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.beforeEach(async ({ page }) => installAttempts(page));

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
			await expect(progress).toContainText("1 delivered in this attempt");
			await expect(progress).toContainText("5 previously closed");
			await expect(progress).toContainText("5 waiting");
		});

		test("puts current work and live monitoring before old attempts", async ({ page }, info) => {
			await openCase(page, c, fixture);
			const current = page.getByRole("region", { name: "Current work", exact: true });
			await expect(current.getByRole("heading", { name: TITLE })).toBeInViewport();
			await expect(current.getByText("Task 7 of 12", { exact: true })).toBeVisible();
			await expect(current.getByRole("link", { name: "Live log" })).toHaveAttribute(
				"href",
				`#/runs/${fixture.ids.runs.running}`,
			);
			await expect(current.getByText(/Started|Stage running for/)).toBeVisible();
			await screenshotCase(page, { ...c, name: `current-work.${c.viewport}.${c.theme}` }, info);
		});
	});
}
