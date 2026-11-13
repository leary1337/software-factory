import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { StateError } from "../errors.ts";
import { CampaignStateStore } from "./state-store.ts";

const clock = new FixedClock(1_000_000);

let dir: string;
let store: CampaignStateStore;
let campaignId: string;
let workItemId: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "campaign-journal-"));
	store = new CampaignStateStore(join(dir, "state.db"), {
		clock,
		ids: new SequentialIdGenerator(),
	});
	const campaign = store.campaigns.createCampaign({
		manifestDigest: "digest-journal",
		manifestJson: "{}",
	});
	campaignId = campaign.id;
	workItemId = store.campaigns.addWorkItem({
		campaignId,
		position: 1,
		issueRef: "issue://1",
	}).id;
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function actionIdByKey(key: string): string {
	const action = store.actions.getActionByKey(key);
	if (action === null) throw new Error(`missing action under key ${key}`);
	return action.id;
}

function beginDispatch(key = "warren:dispatch:digest-journal:1") {
	return store.actions.beginAction({
		actionKey: key,
		campaignId,
		workItemId,
		actionType: "warren_dispatch",
		requestDigest: "request-digest-1",
	});
}

describe("action journal", () => {
	test("persists a planned intent before any caller I/O", () => {
		const action = beginDispatch();
		expect(action.state).toBe("planned");
		expect(action.attempt).toBe(1);
		expect(action.startedAtMs).toBeNull();
		expect(action.createdAtMs).toBe(clock.nowMs());
	});

	test("replaying the same deterministic action key is idempotent", () => {
		const first = beginDispatch();
		const replayed = beginDispatch();
		expect(replayed.id).toBe(first.id);
		expect(store.actions.listActionsForWorkItem(workItemId)).toHaveLength(1);
	});

	test("the same key with a different request digest fails closed", () => {
		beginDispatch();
		expect(() =>
			store.actions.beginAction({
				actionKey: "warren:dispatch:digest-journal:1",
				campaignId,
				workItemId,
				actionType: "warren_dispatch",
				requestDigest: "request-digest-OTHER",
			}),
		).toThrow(StateError);
	});

	test("one active attempt per campaign work item", () => {
		beginDispatch();
		expect(() =>
			store.actions.beginAction({
				actionKey: "warren:dispatch:digest-journal:1:retry",
				campaignId,
				workItemId,
				actionType: "warren_dispatch",
				requestDigest: "request-digest-1",
			}),
		).toThrow(/active attempt/);

		store.actions.markExecuting(actionIdByKey("warren:dispatch:digest-journal:1"));
		expect(() =>
			store.actions.beginAction({
				actionKey: "warren:dispatch:digest-journal:1:retry2",
				campaignId,
				workItemId,
				actionType: "warren_dispatch",
				requestDigest: "request-digest-1",
			}),
		).toThrow(/active attempt/);

		// After a terminal settlement a new attempt may begin.
		store.actions.settleAction(actionIdByKey("warren:dispatch:digest-journal:1"), {
			state: "retryable_failure",
			errorClass: "timeout",
		});
		const retry = store.actions.beginAction({
			actionKey: "warren:dispatch:digest-journal:1:retry3",
			campaignId,
			workItemId,
			actionType: "warren_dispatch",
			requestDigest: "request-digest-1",
			attempt: 2,
		});
		expect(retry.state).toBe("planned");
	});

	test("planned → executing → succeeded records results and freezes the row", () => {
		const planned = beginDispatch();
		const executing = store.actions.markExecuting(planned.id);
		expect(executing.state).toBe("executing");
		expect(executing.startedAtMs).toBe(clock.nowMs());
		const succeeded = store.actions.settleAction(planned.id, {
			state: "succeeded",
			resultRunId: "run_123",
			resultBranch: "warren/run_123",
		});
		expect(succeeded.state).toBe("succeeded");
		expect(succeeded.resultRunId).toBe("run_123");
		expect(succeeded.settledAtMs).toBe(clock.nowMs());
		expect(() => store.actions.markExecuting(planned.id)).toThrow(StateError);
		expect(() => store.actions.settleAction(planned.id, { state: "uncertain" })).toThrow(
			/already settled/,
		);
	});

	test("a lost response settles planned → uncertain without observing execution", () => {
		const planned = beginDispatch();
		const settled = store.actions.settleAction(planned.id, {
			state: "uncertain",
			errorClass: "ambiguous_response",
		});
		expect(settled.state).toBe("uncertain");
		expect(settled.errorClass).toBe("ambiguous_response");
		expect(settled.startedAtMs).toBe(clock.nowMs());
	});

	test("listUnfinishedActions exposes the restart-reconciliation set", () => {
		const a = beginDispatch();
		const other = store.actions.beginAction({
			actionKey: "pr:intent:digest-journal:1",
			campaignId,
			actionType: "pr_intent",
			requestDigest: "pr-request-1",
		});
		store.actions.settleAction(other.id, { state: "succeeded" });
		const unfinished = store.actions.listUnfinishedActions();
		expect(unfinished.map((action) => action.id)).toEqual([a.id]);
	});
});

describe("campaign and work-item invariants", () => {
	test("a manifest digest can be stored only once", () => {
		expect(() =>
			store.campaigns.createCampaign({ manifestDigest: "digest-journal", manifestJson: "{}" }),
		).toThrow(StateError);
	});

	test("a work-item position is unique inside its campaign", () => {
		store.campaigns.addWorkItem({ campaignId, position: 2, issueRef: "issue://2" });
		expect(() =>
			store.campaigns.addWorkItem({ campaignId, position: 2, issueRef: "issue://2b" }),
		).toThrow(StateError);
		expect(store.campaigns.listWorkItems(campaignId)).toHaveLength(2);
	});

	test("approval stamps the immutable manifest without rebinding it", () => {
		const campaign = store.campaigns.getCampaign(campaignId);
		expect(campaign?.approvedAtMs).toBeNull();
		const approved = store.campaigns.approveCampaign(campaignId);
		expect(approved.approvedAtMs).toBe(clock.nowMs());
		expect(approved.manifestDigest).toBe("digest-journal");
	});
});
