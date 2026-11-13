/** warren-f105: a workflow may finish before the first refresh observes it running. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
const projectId = fixture.ids.projects.withSeeds.id;

for (const c of cases.filter((entry) => entry.page.id === "production")) {
	for (const conclusion of ["success", "failure"] as const) {
		test.describe(`fast deploy ${conclusion} ${c.name}`, () => {
			test.use({ viewport: c.size, colorScheme: c.theme });
			test("observes a completed workflow without treating it as a live release", async ({
				page,
			}) => {
				let dispatched = false;
				await page.route(`**/projects/${projectId}/deploy`, async (route) => {
					if (route.request().method() === "POST") {
						dispatched = true;
						return route.fulfill({ json: { dispatched: true, branch: "main" } });
					}
					return route.fulfill({
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
							latestRun: {
								id: dispatched ? 124 : 123,
								status: "completed",
								conclusion: dispatched ? conclusion : "success",
								url: `https://github.com/example/project/actions/runs/${dispatched ? 124 : 123}`,
							},
							history: [],
							activePlan: null,
							error: null,
						},
					});
				});
				await openCase(page, { ...c, url: `${c.url}?project=${projectId}` }, fixture);
				await page.getByRole("button", { name: "Deploy", exact: true }).click();
				await page.getByRole("dialog").getByRole("button", { name: "Deploy", exact: true }).click();
				await expect(page.getByRole("button", { name: "Deploy", exact: true })).toBeEnabled();
				await expect(
					page.getByRole("link", { name: `Workflow · ${conclusion} ↗` }),
				).toHaveAttribute("href", "https://github.com/example/project/actions/runs/124");
				await expect(page.getByText("Release aaaaaaa", { exact: false })).toBeVisible();
			});
		});
	}
}
