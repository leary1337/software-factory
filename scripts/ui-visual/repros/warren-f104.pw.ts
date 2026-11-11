import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase, screenshotCase } from "../harness.ts";

// warren-f104: compact dated history, mobile cost placement and totals across attempts.
const { fixture, cases } = harnessCases();
const TITLE = "Task with a long review history";
const START = "2026-06-01T10:00:00.000Z";
const END = "2026-06-01T10:02:30.000Z";
const REPORT_END = "End of the complete review report.";

async function installCosts(page: Page) {
	const response = await page.request.get(
		`${fixture.baseUrl}/plan-runs/${fixture.ids.planRun.id}`,
		{
			headers: { Authorization: `Bearer ${fixture.token}` },
		},
	);
	const detail = (await response.json()) as PlanRunDetailResponse;
	const template = detail.children[0];
	const run = detail.runs[0];
	if (!template?.metrics || !run) throw new Error("Missing fixture metrics and execution");
	const metrics = template.metrics;
	detail.planRun.planName = "Workout reliability";
	detail.planRun.state = "running";
	detail.children = Array.from({ length: 12 }, (_, index) => ({
		...template,
		seq: index + 1,
		seedId: `workout-${index + 1}`,
		title: index === 0 ? TITLE : `Workout step ${index + 1}`,
		state: index < 2 ? "merged" : "pending",
		runId: index === 0 ? run.id : null,
		reviewStage: null,
		reviewMerge: null,
		failureReason: null,
		budget: null,
		metrics: {
			...metrics,
			costUsd: index === 0 ? 8.5644 : index === 1 ? 2.8644 : 0,
			costUnknownRuns: 0,
			incomplete: false,
			missingRunCount: 0,
			runCount: index < 2 ? 3 : 0,
		},
		reviewSteps:
			index === 0
				? [
						{ runId: "history-review", step: "review", executionState: "succeeded", summary: null },
						{ runId: "history-rework", step: "rework", executionState: "succeeded", summary: null },
						{
							runId: "history-ui-review",
							step: "ui_review",
							executionState: "succeeded",
							summary: {
								status: "passed",
								verdict: "PASS",
								qualityGate: "PASS",
								reviewedCommit: "a".repeat(40),
								gateVerified: true,
								reason: `All checks passed. ${"Detailed finding and validation notes. ".repeat(100)}${REPORT_END}`,
							},
						},
					]
				: [],
	}));
	const first = detail.children[0];
	if (!first) throw new Error("Missing history task");
	const old: PlanRunDetailResponse = {
		...detail,
		planRun: {
			...detail.planRun,
			id: "old-workout-attempt",
			state: "cancelled",
			createdAt: "2026-05-31T10:00:00.000Z",
		},
		children: [
			{
				...first,
				planRunId: "old-workout-attempt",
				state: "failed",
				runId: null,
				metrics: {
					...template.metrics,
					costUsd: 1.2344,
					costUnknownRuns: 0,
					incomplete: false,
					missingRunCount: 0,
					runCount: 1,
				},
			},
		],
	};
	const plans = [detail, old];
	await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { planRuns: plans.map((item) => item.planRun) } }),
	);
	for (const item of plans) {
		await page.route(`**/plan-runs/${item.planRun.id}`, (route) => route.fulfill({ json: item }));
	}
	await page.route("**/runs/history-*", (route) =>
		route.fulfill({
			json: {
				run: {
					...run,
					id: new URL(route.request().url()).pathname.split("/").at(-1),
					state: "succeeded",
					startedAt: START,
					endedAt: END,
				},
			},
		}),
	);
	return { detail, old };
}

for (const c of cases.filter((entry) => entry.page.id === "plan-run-detail")) {
	test.describe(`warren-f104 ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		let data: Awaited<ReturnType<typeof installCosts>>;
		test.beforeEach(async ({ page }) => {
			data = await installCosts(page);
		});

		test("keeps the latest report compact while retaining the full report on demand", async ({
			page,
		}, info) => {
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const history = page.getByRole("region", { name: "Execution history", exact: true });
			await expect(history).toHaveCount(1);
			const latest = history.locator("ol > li").first();
			expect(
				await latest.evaluate((element) => element.getBoundingClientRect().height),
			).toBeLessThan(320);
			await expect(latest).toContainText("Review passed");
			await expect(page.getByText(new RegExp(REPORT_END))).not.toBeVisible();
			await expect(latest.locator(`time[datetime="${START}"]`)).toBeVisible();
			await screenshotCase(page, { ...c, name: `compact-history.${c.viewport}.${c.theme}` }, info);
			await page.getByText("Report for UI/UX review 1", { exact: true }).press("Enter");
			await expect(page.getByText(new RegExp(REPORT_END))).toBeVisible();
		});

		test("shows the execution dates and duration without opening run logs", async ({ page }) => {
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const steps = page
				.getByRole("region", { name: "Execution history", exact: true })
				.locator("ol > li");
			for (let index = 0; index < 3; index++) {
				await expect(steps.nth(index).locator(`time[datetime="${START}"]`)).toBeVisible();
				await expect(steps.nth(index).locator(`time[datetime="${END}"]`)).toBeVisible();
				await expect(steps.nth(index)).toContainText("Duration: 2m 30s");
			}
		});

		test("places plan cost before the long task list and explains display rounding", async ({
			page,
		}) => {
			await openCase(page, c, fixture);
			const cost = page.getByRole("region", { name: "Plan cost", exact: true });
			const tasks = page.getByRole("region", { name: "Plan tasks", exact: true });
			const bottom = await cost.evaluate((element) => element.getBoundingClientRect().bottom);
			const top = await tasks.evaluate((element) => element.getBoundingClientRect().top);
			expect(bottom).toBeLessThanOrEqual(top);
			await expect(cost).toContainText("$11.43");
			await expect(cost).toContainText("before rounding");
			await cost.getByText("Cost calculation", { exact: true }).click();
			await expect(cost).toContainText("$8.564400");
			await expect(cost).toContainText("$11.428800");
			await expect(cost).toContainText("+$0.01");
		});

		test("shows a total across loaded task attempts without adding rounded row values", async ({
			page,
		}) => {
			await openCase(page, { ...c, url: "/#/tasks" }, fixture);
			const card = page
				.getByRole("article")
				.filter({ has: page.getByRole("heading", { name: TITLE, exact: true }) });
			await expect(card).toContainText("Across 2 loaded attempts: $9.80");
			await card.getByText("Attempt history (2)", { exact: true }).click();
			await expect(card).toContainText("$1.23");
			await card.getByText("Cost calculation", { exact: true }).click();
			await expect(card).toContainText("$9.798800");
			await card.getByRole("link", { name: TITLE, exact: true }).click();
			const attempts = page.getByRole("region", { name: "Attempt costs", exact: true });
			await expect(attempts).toContainText("Across 2 loaded attempts: $9.80");
			await attempts.getByText("Attempt history (2)", { exact: true }).click();
			await attempts.getByRole("link", { name: /Cancelled/ }).click();
			await expect(page.getByRole("region", { name: "Task cost", exact: true })).toContainText(
				"$1.23",
			);
			await expect(attempts).toContainText("Across 2 loaded attempts: $9.80");
		});

		test("keeps unknown attempt costs explicit and recovers an unavailable attempt", async ({
			page,
		}) => {
			const oldChild = data.old.children[0];
			if (!oldChild?.metrics) throw new Error("Missing older metrics");
			const metrics = oldChild.metrics;
			oldChild.metrics = undefined;
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const panel = page.getByRole("region", { name: "Attempt costs", exact: true });
			await expect(panel).toContainText("Across 2 loaded attempts: $8.56 + unknown");
			await page.route("**/plan-runs/old-workout-attempt", (route) =>
				route.fulfill({ status: 503, json: { error: "Unavailable" } }),
			);
			await page.reload();
			await expect(panel).toContainText("The loaded subtotal may omit costs.");
			await expect(panel).toContainText("Across 1 loaded attempt: $8.56");
			oldChild.metrics = metrics;
			await page.route("**/plan-runs/old-workout-attempt", (route) =>
				route.fulfill({ json: data.old }),
			);
			await panel.getByRole("button", { name: "Retry attempt costs" }).click();
			await expect(panel).toContainText("Across 2 loaded attempts: $9.80");
		});

		test("recovers step dates and never invents a duration for a finished step without an end", async ({
			page,
		}) => {
			const run = data.detail.runs[0];
			if (!run) throw new Error("Missing run");
			await page.route("**/runs/history-ui-review", (route) =>
				route.fulfill({ status: 503, json: { error: "Unavailable" } }),
			);
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			const latest = page
				.getByRole("region", { name: "Execution history", exact: true })
				.locator("ol > li")
				.first();
			await expect(latest).toContainText("Timing unavailable.");
			await page.route("**/runs/history-ui-review", (route) =>
				route.fulfill({
					json: {
						run: {
							...run,
							id: "history-ui-review",
							state: "succeeded",
							startedAt: START,
							endedAt: null,
						},
					},
				}),
			);
			await latest.getByRole("button", { name: "Retry timing for UI/UX review 1" }).click();
			await expect(latest).toContainText("End time unavailable");
			await expect(latest).toContainText("Duration: Unknown");
			await expect(latest).not.toContainText("in progress");
		});

		test("loads execution timing only for the visible history page", async ({ page }) => {
			const child = data.detail.children[0];
			if (!child?.reviewSteps?.[0]) throw new Error("Missing review");
			const step = child.reviewSteps[0];
			child.reviewSteps = Array.from({ length: 12 }, (_, index) => ({
				...step,
				runId: `history-${index}`,
			}));
			const requested = new Set<string>();
			page.on("request", (request) => {
				if (/\/runs\/history-\d+$/.test(request.url())) requested.add(request.url());
			});
			await openCase(page, { ...c, url: `${c.url}?task=1` }, fixture);
			expect(requested.size).toBe(8);
			await page.getByRole("button", { name: "Show more steps (4 remaining)" }).click();
			await expect.poll(() => requested.size).toBe(12);
		});
	});
}
