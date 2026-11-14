import { expect, test } from "@playwright/test";
import type { PlanApproval, PreparePlanApproval } from "../../src/core/plan-approval.ts";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "project-detail")) {
	test.describe(`factory approval ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("saves concrete approval before starting and reopens the same snapshot", async ({
			page,
		}) => {
			await page.route("**/projects/*/readiness", (route) =>
				route.fulfill({ json: { ready: true, stale: false, fingerprint: "ready", checks: [] } }),
			);
			let saved: PlanApproval | undefined;
			const starts: string[] = [];
			await page.route("**/plan-approvals", async (route) => {
				const input = route.request().postDataJSON() as PreparePlanApproval;
				saved = approval(input);
				await route.fulfill({ json: { approval: saved } });
			});
			await page.route("**/plan-approvals/approval-test", (route) =>
				route.fulfill({ json: { approval: saved } }),
			);
			await page.route("**/plan-approvals/approval-test/start", (route) => {
				starts.push(route.request().url());
				return route.fulfill({
					status: 503,
					json: { error: { code: "unavailable", message: "Reply interrupted" } },
				});
			});
			await openCase(page, c, fixture);
			await page.getByRole("button", { name: "Prepare a plan", exact: true }).click();
			await page.getByLabel("Plan title", { exact: true }).fill("A clearer checkout");
			await page.getByLabel("Task title", { exact: true }).fill("Explain the delivery date");
			await page
				.getByLabel("Task description", { exact: true })
				.fill("Show the expected delivery date before payment.");
			await page
				.getByLabel("Acceptance criteria (one per line)", { exact: true })
				.fill("A customer sees the date before confirming payment.");
			await page.getByRole("button", { name: "Save plan for approval", exact: true }).click();
			await expect(page.getByRole("region", { name: "Plan approval", exact: true })).toBeVisible();
			expect(starts).toEqual([]);
			expect(saved?.snapshot.tasks[0]?.description).toContain("before payment");
			await page.reload();
			await expect(
				page.getByRole("heading", { name: "A clearer checkout", exact: true }),
			).toBeVisible();
			await expect(page.getByText("codex · reviewer-model", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Approve and start this plan", exact: true }).click();
			await expect(page.getByText("Could not confirm plan start", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Approve and start this plan", exact: true }).click();
			await expect.poll(() => starts.length).toBe(2);
			expect(new Set(starts).size).toBe(1);
			expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
				false,
			);
		});
	});
}
function approval(input: PreparePlanApproval): PlanApproval {
	return {
		id: "approval-test",
		commandKey: input.commandKey,
		digest: "digest",
		revision: 1,
		supersedesId: null,
		planRunId: null,
		decision: "Prepared",
		createdAt: "2026-01-01",
		snapshot: {
			version: 1,
			taskSource: "internal",
			projectId: input.projectId,
			title: input.title,
			tasks: input.tasks.map((task, index) => ({
				...task,
				seq: index + 1,
				id: `task-${index}`,
				dependsOn: task.dependsOn ?? [],
				releaseAfter: task.releaseAfter ?? false,
				permissions: task.permissions ?? [],
				initialStatus: "open",
			})),
			profiles: {
				implementation: { runtime: "codex", model: "executor-model" },
				review: { runtime: "codex", model: "reviewer-model" },
			},
			toolkitVersion: "saved-tools",
			settings: {},
			agents: {},
			budgets: {
				repairs: 2,
				reworks: 2,
				runMs: 60_000,
				activeMs: 600_000,
				externalWaitMs: 600_000,
			},
			permissions: [],
			baseBranch: "main",
			agentName: "implementer",
		},
	};
}
