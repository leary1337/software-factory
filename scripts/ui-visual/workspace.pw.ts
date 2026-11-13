import { expect, type Page, test } from "@playwright/test";
import type { RunRow } from "../../src/ui/src/api/types.ts";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
const projectId = fixture.ids.projects.withSeeds.id;
const TITLE = "Сохранить фильтры проекта";

async function standalone(page: Page) {
	const response = await page.request.get(`${fixture.baseUrl}/runs/${fixture.ids.runs.running}`, {
		headers: { Authorization: `Bearer ${fixture.token}` },
	});
	const { run } = (await response.json()) as { run: RunRow };
	Object.assign(run, { prompt: TITLE, seedId: null, parentRunId: null, retryOf: null, projectId });
	await page.route(/\/plan-runs(?:\?.*)?$/, (route) => route.fulfill({ json: { planRuns: [] } }));
	await page.route(/\/runs(?:\?.*)?$/, (route) =>
		route.fulfill({ json: { runs: [run], total: 1, limit: 200, offset: 0, costPricedCount: 0 } }),
	);
	await page.route(`**/runs/${run.id}`, (route) => route.fulfill({ json: { run } }));
	return run;
}

for (const c of cases.filter((entry) => entry.page.id === "overview")) {
	test.describe(`workspace ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("retains project scope and opens a task without leaving the board", async ({ page }) => {
			const run = await standalone(page);
			await openCase(page, c, fixture);
			await page.getByRole("combobox", { name: "Проект", exact: true }).selectOption(projectId);
			await page.getByRole("button", { name: TITLE }).click();
			const panel = page.getByRole("dialog");
			await expect(panel.getByRole("heading", { name: TITLE })).toBeVisible();
			await panel.getByLabel("Уточнение агенту").fill("Сохрани совместимость");
			let body: unknown;
			await page.route(`**/runs/${run.id}/steer`, async (route) => {
				body = route.request().postDataJSON();
				await route.fulfill({ json: { message: {} } });
			});
			await panel.getByRole("button", { name: "Отправить", exact: true }).click();
			await expect(panel.getByRole("status")).toContainText("Сообщение передано");
			expect(body).toEqual({ body: "Сохрани совместимость" });
			await panel.getByRole("button", { name: "Close", exact: true }).click();
			await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
			await page
				.getByRole("link", { name: "Kanban", exact: true })
				.filter({ visible: true })
				.click();
			await expect(page.getByRole("combobox", { name: "Проект", exact: true })).toHaveValue(
				projectId,
			);
			await expect(page.getByRole("button", { name: TITLE })).toBeVisible();
			await page
				.getByRole("link", { name: "Production", exact: true })
				.filter({ visible: true })
				.click();
			await expect(page.getByRole("combobox", { name: "Проект", exact: true })).toHaveValue(
				projectId,
			);
			await page.reload();
			await expect(page.getByRole("combobox", { name: "Проект", exact: true })).toHaveValue(
				projectId,
			);
		});
		test("creates a task with the selected project and role", async ({ page }) => {
			await standalone(page);
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: "Новая задача" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Проект", { exact: true }).selectOption(projectId);
			await dialog.getByLabel("Ожидаемый результат").fill("Добавить поиск по задачам");
			await dialog.getByRole("button", { name: "Далее" }).click();
			await expect(dialog.getByLabel("Агент", { exact: true }).locator("option")).not.toHaveCount(
				1,
			);
			const agent = await dialog
				.getByLabel("Агент", { exact: true })
				.locator("option")
				.nth(1)
				.getAttribute("value");
			await dialog.getByLabel("Агент", { exact: true }).selectOption(agent ?? "");
			let posted: unknown;
			await page.route(/\/runs$/, async (route) => {
				posted = route.request().postDataJSON();
				await route.fulfill({ json: { run: { id: "new-run" } } });
			});
			await dialog.getByRole("button", { name: "Запустить", exact: true }).click();
			await expect(dialog).not.toBeVisible();
			expect(posted).toEqual({ agent, project: projectId, prompt: "Добавить поиск по задачам" });
		});
		test("cancels the selected execution and offers a linked retry", async ({ page }) => {
			const run = await standalone(page);
			let cancelled = "";
			await page.route(`**/runs/${run.id}/cancel`, async (route) => {
				cancelled = route.request().url();
				run.state = "cancelled";
				await route.fulfill({
					json: { state: "cancelled", alreadyTerminal: false, sandboxRun: null },
				});
			});
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: TITLE }).click();
			const panel = page.getByRole("dialog");
			await panel.getByRole("button", { name: "Остановить задачу" }).click();
			await expect(panel.getByRole("link", { name: "Запустить заново" })).toBeVisible();
			expect(cancelled).toContain(`/runs/${run.id}/cancel`);
			await panel.getByRole("link", { name: "Запустить заново" }).click();
			await expect(page).toHaveURL(/#\/dispatch$/);
			await expect(page.locator("textarea").filter({ visible: true }).first()).toHaveValue(TITLE);
		});
		test("selects an existing plan without creating a separate execution", async ({ page }) => {
			await standalone(page);
			await page.route(`**/projects/${projectId}/seeds/plans`, (route) =>
				route.fulfill({
					json: { plans: [{ id: "plan-approved", name: "Улучшение поиска", status: "approved" }] },
				}),
			);
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: "Новая задача" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Проект", { exact: true }).selectOption(projectId);
			await dialog.getByLabel("Ожидаемый результат").fill("Поиск работает на телефоне");
			await dialog.getByRole("button", { name: "Далее" }).click();
			await dialog.getByLabel("Способ выполнения").selectOption("plan");
			await dialog.getByLabel("План", { exact: true }).selectOption("plan-approved");
			await expect(dialog.getByLabel("Агент", { exact: true }).locator("option")).not.toHaveCount(
				1,
			);
			const agent = await dialog
				.getByLabel("Агент", { exact: true })
				.locator("option")
				.nth(1)
				.getAttribute("value");
			await dialog.getByLabel("Агент", { exact: true }).selectOption(agent ?? "");
			let posted: unknown;
			await page.route(/\/plan-runs$/, async (route) => {
				if (route.request().method() === "GET") return route.fulfill({ json: { planRuns: [] } });
				posted = route.request().postDataJSON();
				return route.fulfill({ json: { planRun: { id: "new-plan" }, children: [] } });
			});
			await dialog.getByRole("button", { name: "Запустить", exact: true }).click();
			await expect(dialog).not.toBeVisible();
			expect(posted).toEqual({
				project: projectId,
				agent,
				planId: "plan-approved",
				promptTemplate: "Поиск работает на телефоне\n\nЗадача: {seed_id}",
			});
		});

		test("keeps failed data visible as an error, with a working retry", async ({ page }) => {
			await standalone(page);
			let failing = true;
			await page.route(/\/plan-runs(?:\?.*)?$/, (route) =>
				route.fulfill(
					failing
						? { status: 503, json: { error: "Temporary failure" } }
						: { json: { planRuns: [] } },
				),
			);
			await openCase(page, c, fixture);
			await expect(
				page.getByRole("alert").filter({ hasText: "Не удалось обновить данные" }),
			).toBeVisible();
			failing = false;
			await page.getByRole("button", { name: "Повторить", exact: true }).click();
			await expect(
				page.getByRole("alert").filter({ hasText: "Не удалось обновить данные" }),
			).not.toBeVisible();
			await expect(page.getByRole("button", { name: TITLE })).toBeVisible();
		});
	});
}

for (const c of cases.filter((entry) => entry.page.id === "production")) {
	test.describe(`release ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("dispatches the selected project and waits for real deployment state", async ({
			page,
		}) => {
			let dispatched = false;
			let calls = 0;
			await page.route(`**/projects/${projectId}/deploy`, async (route) => {
				if (route.request().method() === "POST") {
					calls++;
					dispatched = true;
					await route.fulfill({ json: { dispatched: true, branch: "main" } });
					return;
				}
				await route.fulfill({
					json: {
						configured: true,
						workflow: "deploy.yml",
						environment: "production",
						branch: "main",
						current: { sha: "a".repeat(40), createdAt: fixture.frozenNow, state: "success" },
						currentState: "deployed",
						candidateSha: "b".repeat(40),
						behind: {
							count: 1,
							changes: [{ sha: "b".repeat(40), title: "Сохранение настроек списка" }],
						},
						activeRun: dispatched
							? {
									id: 123,
									status: "in_progress",
									url: "https://github.com/example/project/actions/runs/123",
								}
							: null,
						history: [],
						activePlan: null,
						error: null,
					},
				});
			});
			await openCase(page, { ...c, url: `${c.url}?project=${projectId}` }, fixture);
			await expect(page.getByText("Release aaaaaaa", { exact: false })).toBeVisible();
			await expect(page.getByText("Следующий Release · bbbbbbb · main")).toBeVisible();
			await page.getByRole("button", { name: "Deploy", exact: true }).click();
			await expect(page.getByRole("dialog")).toContainText("Сохранение настроек списка");
			await page.getByRole("dialog").getByRole("button", { name: "Deploy", exact: true }).click();
			await expect(page.getByRole("link", { name: /Deploying/ })).toBeVisible();
			await expect(page.getByText("Release aaaaaaa", { exact: false })).toBeVisible();
			await expect(page.getByRole("button", { name: "Deploy", exact: true })).toHaveCount(0);
			expect(calls).toBe(1);
		});
	});
}
