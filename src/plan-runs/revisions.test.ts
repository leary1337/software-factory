import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { approvedFixture } from "./approval-test-helpers.ts";
import { loadTaskApproval } from "./approved-dispatch.ts";
import { reviseApprovedPlan } from "./revisions.ts";

let fixture: Awaited<ReturnType<typeof approvedFixture>>;
beforeEach(async () => {
	fixture = await approvedFixture();
});
afterEach(async () => {
	await fixture.dispose();
});
const task = {
	seq: 2,
	title: "Changed second task",
	description: "Updated description",
	acceptance: ["New explicit check"],
};
const command = {
	commandKey: "revision-1",
	expectedRevision: 1,
	decision: "Approve changed acceptance for remaining work",
	tasks: [task],
	settings: { memoryEnabled: true },
};
describe("approved revisions", () => {
	test("preserves a running step while changing remaining work and records both versions", async () => {
		await fixture.repos.planRuns.updateChild({
			planRunId: fixture.planRun.id,
			seq: 1,
			patch: { state: "dispatched" },
		});
		const revision = await reviseApprovedPlan(fixture.repos, fixture.planRun.id, command);
		expect(revision.revision).toBe(2);
		expect(revision.snapshot.tasks[0]).toEqual(fixture.approval.snapshot.tasks[0]);
		expect(revision.snapshot.tasks[1]?.acceptance).toEqual(task.acceptance);
		expect((await loadTaskApproval(fixture.repos, fixture.planRun.id, 1))?.revision).toBe(1);
		expect((await loadTaskApproval(fixture.repos, fixture.planRun.id, 2))?.revision).toBe(2);
		await fixture.reopen();
		expect(await fixture.repos.planApprovals.history(fixture.planRun.id)).toHaveLength(2);
		expect((await reviseApprovedPlan(fixture.repos, fixture.planRun.id, command)).id).toBe(
			revision.id,
		);
		await expect(
			reviseApprovedPlan(fixture.repos, fixture.planRun.id, {
				...command,
				tasks: [{ ...task, title: "Changed command" }],
			}),
		).rejects.toThrow("key");
	});
	test("refuses changed acceptance for work that has already started", async () => {
		await fixture.repos.planRuns.updateChild({
			planRunId: fixture.planRun.id,
			seq: 1,
			patch: { state: "dispatched" },
		});
		await expect(
			reviseApprovedPlan(fixture.repos, fixture.planRun.id, {
				...command,
				tasks: [{ ...task, seq: 1 }],
			}),
		).rejects.toThrow("cannot be rewritten");
		expect(await fixture.repos.planApprovals.history(fixture.planRun.id)).toHaveLength(1);
	});
});
