import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { harnessCases, openCase, screenshotCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "plan-run-detail")) {
	test(`task detail ${c.name} keeps implementation and review in one task`, async ({
		page,
	}, info) => {
		await page.setViewportSize(c.size);
		await page.route(`**/plan-runs/${fixture.ids.planRun.id}`, async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			const child = body.children[0];
			Object.assign(child, {
				title: "Refine onboarding",
				state: "pr_open",
				reviewStage: "reworking",
				reviewSteps: [
					{
						runId: "review-one",
						step: "review",
						executionState: "succeeded",
						summary: {
							status: "checks_not_run",
							verdict: "CHANGES",
							qualityGate: "NOT_RUN",
							reviewedCommit: "a".repeat(40),
							reason: "Install missing test dependencies.",
						},
					},
					{ runId: "rework-one", step: "rework", executionState: "running", summary: null },
				],
			});
			await route.fulfill({ response, json: body });
		});
		await page.route("**/runs/rework-one", (route) =>
			route.fulfill({
				json: {
					run: { id: "rework-one", state: "running", startedAt: fixture.frozenNow, endedAt: null },
				},
			}),
		);
		await page.route("**/runs/review-one", (route) =>
			route.fulfill({
				json: {
					run: {
						id: "review-one",
						state: "succeeded",
						startedAt: new Date(fixture.frozenNowMs - 120_000).toISOString(),
						endedAt: fixture.frozenNow,
					},
				},
			}),
		);
		await openCase(page, c, fixture);
		await page
			.getByRole("region", { name: "Plan progress", exact: true })
			.getByRole("link", { name: "Refine onboarding", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Refine onboarding", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Execution history", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Rework is addressing the review findings.", { exact: true }),
		).toBeVisible();
		await expect(page.getByText("Checks not run", { exact: true })).toBeVisible();
		await expect(
			page.getByText("Install missing test dependencies.", { exact: true }),
		).toBeVisible();
		await page.getByText("Report for Review 1", { exact: true }).press("Enter");
		await expect(page.getByRole("heading", { name: "Checks not run", exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "Implementation" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Review 1" })).toHaveAttribute(
			"href",
			"#/runs/review-one",
		);
		await expect(page.getByRole("link", { name: "Rework 1" })).toHaveAttribute(
			"href",
			"#/runs/rework-one",
		);
		const widths = await page.evaluate(() => ({
			actual: document.documentElement.scrollWidth,
			viewport: innerWidth,
		}));
		expect(widths.actual).toBeLessThanOrEqual(widths.viewport);
		const contrast = await new AxeBuilder({ page })
			.include("main")
			.withRules(["color-contrast"])
			.analyze();
		expect(contrast.violations.map((violation) => violation.id)).toEqual([]);
		await screenshotCase(
			page,
			{ ...c, name: c.name.replace("plan-run-detail", "task-detail") },
			info,
		);
	});
}
