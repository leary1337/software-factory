/** warren-f106: compact Overview and readable task alerts in both themes. */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { PlanRunDetailResponse, ProjectRow } from "../../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
const TITLE = "Подстановка значений одним нажатием";
const projectId = fixture.ids.projects.withSeeds.id;

async function installWorkspace(page: Page, projectCount = 1) {
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
	detail.children = Array.from({ length: 6 }, (_, index) => ({
		...template,
		seq: index + 1,
		seedId: `compact-${index}`,
		title: index === 0 ? TITLE : `Текущая задача проекта ${index}`,
		state: index === 0 ? "pr_open" : index < 4 ? "pending" : "merged",
		runId: index === 0 ? fixture.ids.runs.succeeded : null,
		prMergedAt: index >= 4 ? fixture.frozenNow : null,
		reviewStage: index === 0 ? "needs_attention" : null,
		failureReason: null,
		budget: null,
		reviewSteps: [],
		reviewMerge:
			index === 0
				? {
						kind: "blocked",
						reason: "protected_path",
						detail: "Automatic merge was refused because protected files changed.",
						nextAction: "Review the named files before merging manually.",
						paths: ["scripts/check.sh", "scripts/workout-rest-smoke.mjs"],
					}
				: null,
	}));
	const projectResponse = await page.request.get(`${fixture.baseUrl}/projects`, {
		headers: { Authorization: `Bearer ${fixture.token}` },
	});
	const inventory = (await projectResponse.json()) as { projects: ProjectRow[] };
	const templateProject = inventory.projects.find((project) => project.id === projectId);
	if (!templateProject) throw new Error("Missing fixture project");
	const projects = Array.from({ length: projectCount }, (_, index) => ({
		...templateProject,
		id: index === 0 ? projectId : `compact-project-${index}`,
		gitUrl: `https://github.com/operator/product-${index}.git`,
	}));
	const details = projects.map((project, index) => ({
		...detail,
		planRun: { ...detail.planRun, id: `${detail.planRun.id}-${index}`, projectId: project.id },
	}));
	await page.route(/\/projects(?:\?.*)?$/, (route) => route.fulfill({ json: { projects } }));
	await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { planRuns: details.map((entry) => entry.planRun) } }),
	);
	for (const entry of details) {
		await page.route(`**/plan-runs/${entry.planRun.id}`, (route) => route.fulfill({ json: entry }));
	}
	await page.route(/\/runs(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { runs: [], total: 0, limit: 200, offset: 0 } }),
	);
	await page.route("**/projects/*/deploy", (route) =>
		route.fulfill({
			json: {
				configured: true,
				workflow: "deploy.yml",
				environment: "production",
				branch: "main",
				current: { sha: "a".repeat(40), createdAt: fixture.frozenNow, state: "success" },
				currentState: "deployed",
				candidateSha: "b".repeat(40),
				behind: { count: 1, changes: [] },
				activeRun: null,
				latestRun: null,
				history: [],
				activePlan: null,
				error: null,
			},
		}),
	);
}

for (const c of cases.filter((entry) => entry.page.id === "overview")) {
	test.describe(`compact readable workspace ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test.beforeEach(async ({ page }) => {
			await installWorkspace(page);
		});
		test("keeps decisions, current work and Production together above the fold", async ({
			page,
		}) => {
			test.skip(c.viewport !== "desktop", "Phones retain readable vertical flow");
			await openCase(page, { ...c, url: `/#/overview?project=${projectId}` }, fixture);
			await expect(page.getByText("Ready to deploy · 1 commits", { exact: true })).toBeVisible();
			for (const size of [c.size, { width: 1366, height: 768 }]) {
				await page.setViewportSize(size);
				for (const name of ["Требует тебя", "Текущая работа", "Production"]) {
					const box = await page.getByRole("region", { name, exact: true }).first().boundingBox();
					expect(box).not.toBeNull();
					expect(
						(box?.y ?? 0) + (box?.height ?? 0),
						`${name} fits ${size.height}px`,
					).toBeLessThanOrEqual(size.height);
				}
				expect(
					await page.locator("main").evaluate((el) => el.scrollHeight - el.clientHeight),
				).toBeLessThanOrEqual(1);
			}
		});
		test("keeps three projects and their releases within a laptop viewport", async ({ page }) => {
			test.skip(c.viewport !== "desktop", "Phones retain readable vertical flow");
			await installWorkspace(page, 3);
			await page.setViewportSize({ width: 1366, height: 768 });
			await openCase(page, c, fixture);
			await expect(page.getByText("Ready to deploy · 1 commits", { exact: true })).toHaveCount(3);
			expect(
				await page.locator("main").evaluate((el) => el.scrollHeight - el.clientHeight),
			).toBeLessThanOrEqual(1);
		});
		test("keeps every warning label, reason and filename readable in the task panel", async ({
			page,
		}) => {
			await openCase(page, { ...c, url: `/#/overview?project=${projectId}` }, fixture);
			await page.getByRole("button", { name: TITLE, exact: true }).click();
			await expect(
				page.getByRole("dialog").getByText("scripts/check.sh", { exact: true }),
			).toBeVisible();
			const result = await new AxeBuilder({ page })
				.include('[role="dialog"]')
				.withRules(["color-contrast"])
				.analyze();
			expect(
				result.violations.map((v) => ({
					id: v.id,
					nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
				})),
			).toEqual([]);
		});
	});
}
