import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

// warren-f102: long review chains, implementation-only costs and unreadable plan tables.
const { fixture, cases } = harnessCases();
const TASK = "Синхронизация: плохая связь, другие телефоны и сохранение истории тренировок";
const PLAN = "Стабильный ввод тренировки и исправление ошибок во всех разделах приложения";

async function installHistory(page: Page) {
	const response = await page.request.get(
		`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
		{
			headers: { Authorization: `Bearer ${fixture.token}` },
		},
	);
	const detail = (await response.json()) as PlanRunDetailResponse;
	const child = detail.children[0];
	const run = detail.runs[0];
	if (!child?.metrics || !run) throw new Error("Fixture requires a task with metrics and a run");
	detail.planRun.planName = PLAN;
	detail.planRun.state = "succeeded";
	detail.children = [child];
	detail.runs = [run];
	run.costUsd = 0.843;
	Object.assign(child, {
		title: TASK,
		state: "merged",
		reviewStage: "ready_to_merge",
		runId: run.id,
		budget: null,
	});
	child.metrics = {
		...child.metrics,
		costUsd: 8.56,
		costUnknownRuns: 0,
		incomplete: false,
		missingRunCount: 0,
		subscriptionEstimateRuns: 29,
		runCount: 29,
		reviewCount: 20,
		reworkCount: 8,
		uiReviewCount: 0,
	};
	child.reviewSteps = Array.from({ length: 20 }, (_, index) => ({
		runId: `review-${index + 1}`,
		step: "review" as const,
		executionState: "succeeded" as const,
		summary: {
			status: index === 19 ? ("passed" as const) : ("changes_requested" as const),
			verdict: index === 19 ? ("PASS" as const) : ("CHANGES" as const),
			qualityGate: "PASS" as const,
			reviewedCommit: "a".repeat(40),
			gateVerified: true,
			reason:
				index === 19
					? "Latest review passed."
					: `Older detailed report ${index + 1}. ${"Finding and validation notes. ".repeat(30)}`,
		},
	})).flatMap((step, index) =>
		index < 8
			? [
					step,
					{
						runId: `rework-${index + 1}`,
						step: "rework" as const,
						executionState: "succeeded" as const,
						summary: null,
					},
				]
			: [step],
	);
	await page.route("**/plan-runs", (route) =>
		route.fulfill({ json: { planRuns: [detail.planRun] } }),
	);
	await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, (route) =>
		route.fulfill({ json: detail }),
	);
	return detail;
}

for (const c of cases.filter((entry) => entry.page.id === "plan-run-detail")) {
	test.describe(`warren-f102 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.beforeEach(async ({ page }) => {
			await installHistory(page);
		});

		test("puts the latest review first and collapses old detailed reports", async ({ page }) => {
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const reviews = page.getByRole("link", { name: /^Review \d+$/ });
			await expect(reviews.first()).toHaveText("Review 20");
			await expect(page.getByText(/^Older detailed report 1\./)).not.toBeVisible();
			await expect(page.getByText("Latest review passed.", { exact: true })).toBeVisible();
		});

		test("shows the same whole-task cost on the plan and task screens", async ({ page }) => {
			await openCase(page, c, fixture);
			await expect(page.getByRole("region", { name: "Plan cost", exact: true })).toContainText(
				"$8.56",
			);
			await page.getByRole("link", { name: new RegExp(TASK) }).click();
			await expect(page.getByRole("region", { name: "Task cost", exact: true })).toContainText(
				"$8.56",
			);
			await expect(page.getByRole("region", { name: "Task cost", exact: true })).toContainText(
				"$0.843",
			);
		});

		test("keeps task and plan names readable without truncation", async ({ page }) => {
			await openCase(page, c, fixture);
			const title = page.getByRole("link", { name: new RegExp(TASK) });
			const text = await title.evaluate((element) => ({
				font: Number.parseFloat(getComputedStyle(element).fontSize),
				width: element.clientWidth,
				scroll: element.scrollWidth,
			}));
			expect(text.font).toBeGreaterThanOrEqual(14);
			expect(text.scroll).toBeLessThanOrEqual(text.width + 1);
			await page.goto(`${fixture.baseUrl}/#/plan-runs`);
			const plan = page.getByRole("link", { name: PLAN, exact: true });
			await expect(plan).toBeVisible();
			expect(
				await plan.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
			).toBeGreaterThanOrEqual(14);
			for (const selector of ["html", "main"]) {
				expect(
					await page
						.locator(selector)
						.evaluate((element) => element.scrollWidth - element.clientWidth),
				).toBeLessThanOrEqual(1);
			}
		});
	});
}
