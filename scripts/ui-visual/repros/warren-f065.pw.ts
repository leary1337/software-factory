/** warren-f065: a completed reviewer process must not look like an approved review. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();
const commit = "a".repeat(40);
const reports = [
	{ verdict: "PASS", gate: "PASS", label: "Review passed", verified: true },
	{ verdict: "CHANGES", gate: "PASS", label: "Changes requested", verified: false },
	{ verdict: "CHANGES", gate: "NOT_RUN", label: "Checks not run", verified: false },
	{ verdict: "PASS", gate: "PASS", label: "Checks not run", verified: false },
] as const;

for (const c of cases.filter((entry) => entry.page.id === "run-detail")) {
	for (const report of reports) {
		test(`warren-f065 ${c.name} ${report.label} ${report.verdict}`, async ({ page }) => {
			await page.setViewportSize(c.size);
			const runId = fixture.ids.runs.running;
			await page.route(`**/runs/${runId}`, async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				await route.fulfill({
					response,
					json: {
						run: {
							...body.run,
							agentName: "reviewer",
							baseCommit: commit,
							state: "succeeded",
							endedAt: new Date(fixture.frozenNowMs).toISOString(),
						},
					},
				});
			});
			await page.route(`**/runs/${runId}/events*`, async (route) => {
				await route.fulfill({
					contentType: "application/x-ndjson",
					body: `${JSON.stringify({
						id: 1,
						seq: 1,
						runId,
						ts: new Date(fixture.frozenNowMs).toISOString(),
						kind: "state_change",
						stream: "system",
						payload: {
							type: "result",
							result: `VERDICT: ${report.verdict}\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: ${report.gate}\nFix the failing acceptance check.`,
						},
					})}\n${report.verified ? `${JSON.stringify({ id: 2, seq: 2, runId, ts: new Date(fixture.frozenNowMs).toISOString(), kind: "quality_gate.completed", stream: "system", payload: { commit, command: "./scripts/check.sh", exitCode: 0 } })}\n` : ""}`,
				});
			});
			await openCase(page, c, fixture);
			await expect(page.getByRole("heading", { name: report.label, exact: true })).toBeVisible();
			await expect(page.getByText("Execution: succeeded", { exact: true })).toBeVisible();
			if (report.verdict === "CHANGES") {
				await expect(
					page.getByText("Fix the failing acceptance check.", { exact: true }),
				).toBeVisible();
			}
			const widths = await page.evaluate(() => ({
				actual: document.documentElement.scrollWidth,
				viewport: innerWidth,
			}));
			expect(widths.actual).toBeLessThanOrEqual(widths.viewport);
		});
	}
}
