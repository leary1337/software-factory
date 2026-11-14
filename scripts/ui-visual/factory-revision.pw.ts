import { expect, test } from "@playwright/test";
import type { PlanApproval, RevisePlanApproval } from "../../src/core/plan-approval.ts";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();
for (const c of cases.filter((entry) => entry.page.id === "plan-run-detail")) {
	test.describe(`factory revision ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("submits only pending changes with an explicit decision and current revision", async ({
			page,
		}) => {
			const current = snapshot();
			let sent: RevisePlanApproval | undefined;
			await page.route(/\/plan-runs\/[^/?]+$/, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				await route.fulfill({
					json: {
						...body,
						planRun: { ...body.planRun, state: "running" },
						children: [
							{ ...body.children[0], seq: 1, state: "running", title: "Already started" },
							{ ...body.children[0], seq: 2, state: "pending", title: "Remaining work" },
						],
					},
				});
			});
			await page.route("**/plan-runs/*/approval", (route) =>
				route.fulfill({ json: { revisions: [current], effects: [] } }),
			);
			await page.route("**/plan-runs/*/revisions", async (route) => {
				sent = route.request().postDataJSON() as RevisePlanApproval;
				current.revision = 2;
				current.decision = sent.decision;
				await route.fulfill({ json: { approval: current } });
			});
			await openCase(page, c, fixture);
			await page.getByText("Approved plan and decisions", { exact: true }).click();
			await expect(page.getByLabel("Task title", { exact: true })).toHaveCount(1);
			await expect(page.getByLabel("Task title", { exact: true })).toHaveValue("Remaining work");
			await page
				.getByRole("textbox", { name: "Task description", exact: true })
				.fill("Show dates on every receipt.");
			await page
				.getByLabel("Decision and reason for revision", { exact: true })
				.fill("Extend the remaining receipt acceptance check.");
			await page
				.getByRole("button", { name: "Approve revised remaining tasks", exact: true })
				.click();
			await expect(
				page.getByText("Revision 2: Extend the remaining receipt acceptance check.", {
					exact: true,
				}),
			).toBeVisible();
			expect(sent?.expectedRevision).toBe(1);
			expect(sent?.tasks.map((task) => task.seq)).toEqual([2]);
			expect(sent?.tasks[0]?.description).toBe("Show dates on every receipt.");
			expect(sent?.commandKey).toBeTruthy();
			await page.unrouteAll({ behavior: "wait" });
		});
	});
}
function snapshot(): PlanApproval {
	return {
		id: "approval-revision",
		commandKey: "original",
		digest: "digest",
		revision: 1,
		supersedesId: null,
		planRunId: "fixture",
		decision: "Original approved plan",
		createdAt: "2026-01-01",
		snapshot: {
			version: 1,
			taskSource: "internal",
			projectId: "project",
			title: "Receipts",
			tasks: [1, 2].map((seq) => ({
				seq,
				id: `task-${seq}`,
				title: seq === 1 ? "Already started" : "Remaining work",
				description: "Explain the receipt.",
				acceptance: ["Every charge is explained."],
				dependsOn: [],
				releaseAfter: false,
				permissions: [],
				initialStatus: "open",
			})),
			profiles: {
				implementation: { runtime: "codex", model: "executor" },
				review: { runtime: "codex", model: "reviewer" },
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
