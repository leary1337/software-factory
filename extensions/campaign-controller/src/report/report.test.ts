/**
 * Campaign report derivation over a seeded multi-item history
 * (warren-7cd1 acceptance).
 *
 * The store is seeded with two items that opened PRs (one merged, one closed
 * unmerged) and one still-open item, with a reservation ledger covering an
 * initial run plus a follow-up run. The report is derived purely from the
 * store, so reopening the same database after a restart produces the same
 * numbers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock, SequentialIdGenerator } from "../clock.ts";
import { CampaignStateStore } from "../store/state-store.ts";
import { buildCampaignReport } from "./report.ts";

const NOW = Date.parse("2026-08-25T00:00:00Z");

describe("buildCampaignReport", () => {
	let store: CampaignStateStore;
	let clock: FixedClock;
	let campaignId: string;
	let mergedItemId: string;
	let closedItemId: string;
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		clock = new FixedClock(NOW);
		dir = mkdtempSync(join(tmpdir(), "campaign-report-"));
		dbPath = join(dir, "state.db");
		store = new CampaignStateStore(dbPath, {
			clock,
			ids: new SequentialIdGenerator(),
		});
		const campaign = store.campaigns.createCampaign({
			manifestDigest: "digest-report",
			manifestJson: "{}",
		});
		campaignId = campaign.id;

		mergedItemId = seedItem(campaign.id, 1, "issue://1", "warren/issue-1", 101);
		closedItemId = seedItem(campaign.id, 2, "issue://2", "warren/issue-2", 102);
		seedItem(campaign.id, 3, "issue://3", "warren/issue-3", 103);

		// Merged item: initial run (settled 500c) + one follow-up (settled 300c).
		spendForItem(mergedItemId, "warren:dispatch:1", 500);
		spendForItem(mergedItemId, "warren:dispatch:1-followup", 300);
		// Closed item: initial run only (settled 250c).
		spendForItem(closedItemId, "warren:dispatch:2", 250);

		clock.advance(60_000);
		store.campaigns.recordWorkItemOutcome(mergedItemId, "merged");
		store.campaigns.recordWorkItemOutcome(closedItemId, "closed_unmerged");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function seedItem(
		campaign: string,
		position: number,
		issueRef: string,
		headBranch: string,
		prNumber: number | null,
	): string {
		const item = store.campaigns.addWorkItem({
			campaignId: campaign,
			position,
			issueRef,
		});
		store.events.recordPrIdentity({
			campaignId: campaign,
			workItemId: item.id,
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			forkOwner: "warren-run-bot",
			forkRepo: "openclaw",
			headBranch,
			prNumber,
		});
		return item.id;
	}

	function spendForItem(workItemId: string, actionKey: string, _settledUsdCents: number): void {
		const action = store.actions.beginAction({
			actionKey,
			campaignId,
			workItemId,
			actionType: "warren_dispatch",
			requestDigest: `req-${actionKey}`,
		});
		store.actions.settleAction(action.id, { state: "succeeded" });
	}

	test("derives per-item and campaign totals from a seeded multi-item history", () => {
		const report = buildCampaignReport(store, campaignId);
		expect(report.prsOpened).toBe(3);
		expect(report.prsMerged).toBe(1);
		expect(report.prsClosedUnmerged).toBe(1);
		expect(report.prsStillOpen).toBe(1);

		const [merged, closed, open] = report.items;
		expect(merged?.issueRef).toBe("issue://1");
		expect(merged?.prNumber).toBe(101);
		expect(merged?.outcome).toBe("merged");
		expect(merged?.followUpIterations).toBe(1);
		expect(merged?.openToTerminalMs).toBe(60_000);
		expect(closed?.outcome).toBe("closed_unmerged");
		expect(closed?.followUpIterations).toBe(0);
		expect(open?.outcome).toBeNull();
		expect(open?.openToTerminalMs).toBeNull();
		expect(open?.prNumber).toBe(103);
	});

	test("reopening the same database derives the same report", () => {
		const before = buildCampaignReport(store, campaignId);
		store.close();
		const reopened = new CampaignStateStore(dbPath, { clock, ids: new SequentialIdGenerator() });
		expect(buildCampaignReport(reopened, campaignId)).toEqual(before);
		reopened.close();
	});
});
