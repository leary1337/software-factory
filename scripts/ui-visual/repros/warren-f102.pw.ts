import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase, screenshotCase } from "../harness.ts";

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
	await page.route(/\/runs\/(?:review|rework)-\d+$/, (route) =>
		route.fulfill({
			json: { run: { ...run, id: new URL(route.request().url()).pathname.split("/").at(-1) } },
		}),
	);
	return detail;
}

for (const c of cases.filter((entry) => entry.page.id === "plan-run-detail")) {
	test.describe(`warren-f102 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		let detail: PlanRunDetailResponse;
		test.beforeEach(async ({ page }) => {
			detail = await installHistory(page);
		});

		test("puts the latest review first and collapses old detailed reports", async ({
			page,
		}, info) => {
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const reviews = page.getByRole("link", { name: /^Review \d+$/ });
			await expect(reviews.first()).toHaveText("Review 20");
			await expect(page.getByText(/^Older detailed report 1\./)).not.toBeVisible();
			await expect(page.getByText("Latest review passed.", { exact: true })).toBeVisible();
			await expect(reviews).toHaveCount(8);
			await screenshotCase(page, { ...c, name: `history.${c.viewport}.${c.theme}` }, info);
			await page.getByRole("button", { name: /Show more steps/ }).click();
			await expect(page.getByRole("link", { name: "Review 12", exact: true })).toBeVisible();
			await page.getByRole("combobox", { name: "History type" }).selectOption("rework");
			await expect(page.getByRole("link", { name: /^Rework \d+$/ }).first()).toHaveText("Rework 8");
			await expect(page.getByRole("link", { name: /^Review \d+$/ })).toHaveCount(0);
			await page.getByRole("combobox", { name: "History order" }).selectOption("oldest");
			await expect(page.getByRole("link", { name: /^Rework \d+$/ }).first()).toHaveText("Rework 1");
			await page.getByRole("combobox", { name: "History type" }).selectOption("review");
			await expect(page.getByRole("link", { name: /^Review \d+$/ }).first()).toHaveText("Review 1");
			await page.getByText("Report for Review 1", { exact: true }).press("Enter");
			await expect(page.getByText(/^Older detailed report 1\./)).toBeVisible();
			await page.getByRole("combobox", { name: "History type" }).selectOption("ui_review");
			await expect(page.getByText("No steps match this filter.", { exact: true })).toBeVisible();
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

		test("keeps task and plan names readable without truncation", async ({ page }, info) => {
			await openCase(page, c, fixture);
			if (c.viewport === "phone") {
				const heading = await page.getByRole("heading", { name: PLAN, exact: true }).boundingBox();
				expect(heading?.width).toBeGreaterThan(c.size.width * 0.85);
			}
			const title = page.getByRole("link", { name: new RegExp(TASK) });
			const text = await title.evaluate((element) => ({
				font: Number.parseFloat(getComputedStyle(element).fontSize),
				width: element.clientWidth,
				scroll: element.scrollWidth,
			}));
			expect(text.font).toBeGreaterThanOrEqual(14);
			expect(text.scroll).toBeLessThanOrEqual(text.width + 1);
			await screenshotCase(page, { ...c, name: `readable-plan.${c.viewport}.${c.theme}` }, info);
			await page.setViewportSize(c.size);
			await page.goto(`${fixture.baseUrl}/#/plan-runs`);
			const plan = page.getByRole("link", { name: PLAN, exact: true });
			await expect(plan).toBeVisible();
			expect(
				await plan.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
			).toBeGreaterThanOrEqual(14);
			await screenshotCase(page, { ...c, name: `readable-plans.${c.viewport}.${c.theme}` }, info);
			for (const selector of ["html", "main"]) {
				expect(
					await page
						.locator(selector)
						.evaluate((element) => element.scrollWidth - element.clientWidth),
				).toBeLessThanOrEqual(1);
			}
		});
		test("keeps partial and unavailable costs explicit across the plan list and details", async ({
			page,
		}) => {
			const child = detail.children[0];
			if (!child?.metrics) throw new Error("Missing metrics");
			const metrics = child.metrics;
			child.metrics = { ...metrics, costUnknownRuns: 2, incomplete: true };
			await openCase(page, c, fixture);
			await expect(page.getByRole("region", { name: "Plan cost", exact: true })).toContainText(
				"$8.56 + unknown",
			);
			await page.goto(`${fixture.baseUrl}/#/plan-runs`);
			await expect(page.getByText("$8.56 + unknown", { exact: true })).toBeVisible();
			child.metrics = undefined;
			await page.goto(`${fixture.baseUrl}${c.url}?task=1`);
			await page.reload();
			const taskCost = page.getByRole("region", { name: "Task cost", exact: true });
			await expect(taskCost).toContainText("Unknown");
			await expect(taskCost).toContainText("$0.843");
			await expect(taskCost).not.toContainText("$0.00");
			child.metrics = { ...metrics, costUsd: 0 };
			await page.reload();
			await expect(taskCost).toContainText("$0.00");
			await expect(taskCost).not.toContainText("+ unknown");
		});

		test("searches plan names and IDs and handles an empty result", async ({ page }) => {
			await openCase(page, { ...c, url: "/#/plan-runs" }, fixture);
			const search = page.getByRole("searchbox", { name: "Search plans" });
			await search.fill("исправление ошибок");
			await expect(page.getByRole("link", { name: PLAN, exact: true })).toBeVisible();
			await search.fill(fixture.ids.planRun.id);
			await expect(page.getByRole("link", { name: PLAN, exact: true })).toBeVisible();
			await search.fill("does not exist");
			await expect(page.getByText(/No plan runs match this filter/)).toBeVisible();
			await page.getByRole("button", { name: "Clear", exact: true }).click();
			await expect(page.getByRole("link", { name: PLAN, exact: true })).toBeVisible();
		});

		test("recovers unavailable plan data without presenting a zero cost", async ({ page }) => {
			await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, (route) =>
				route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }),
			);
			await openCase(page, { ...c, url: "/#/plan-runs" }, fixture);
			await expect(page.getByText("Progress unknown", { exact: true })).toBeVisible();
			await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
			await expect(page.getByText("$0.00", { exact: true })).toHaveCount(0);
			await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, (route) =>
				route.fulfill({ json: detail }),
			);
			await page.getByRole("button", { name: "Retry plan data", exact: true }).click();
			await expect(page.getByText("$8.56", { exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: "Retry plan data" })).toHaveCount(0);
		});

		test("keeps redacted history and limits distinct from empty data", async ({ page }) => {
			const child = detail.children[0];
			if (!child) throw new Error("Missing task");
			child.metrics = undefined;
			child.reviewSteps = undefined;
			detail.planRun.maxCostUsd = undefined;
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const history = page.getByRole("region", { name: "Execution history", exact: true });
			await expect(history).toContainText("Detailed review history is available to the operator.");
			await expect(history).not.toContainText("0 code reviews");
			await page.getByRole("link", { name: "← Back to plan", exact: true }).click();
			await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
			await expect(page.getByText("No limit declared", { exact: true })).toHaveCount(0);
			await page.goto(`${fixture.baseUrl}/#/plan-runs`);
			await expect(
				page.getByText("Implementation run limit: Unavailable", { exact: true }),
			).toBeVisible();
			await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
		});
	});
}
