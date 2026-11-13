import { WARREN_DISPATCH_ACTION_TYPE } from "../dispatch/dispatcher.ts";
import type { CampaignStateStore } from "../store/state-store.ts";
import type { WorkItemOutcome, WorkItemRow } from "../store/types.ts";

/** Terminal-accounting row for one work item. */
export interface WorkItemReportRow {
	readonly workItemId: string;
	readonly issueRef: string;
	readonly prNumber: number | null;
	readonly outcome: WorkItemOutcome | null;
	/** Dispatch runs beyond the first for this item. */
	readonly followUpIterations: number;
	/** Outcome stamp minus work-item creation; null while no outcome. */
	readonly openToTerminalMs: number | null;
}

/** Campaign-level terminal accounting rollup. */
export interface CampaignReport {
	readonly campaignId: string;
	readonly prsOpened: number;
	readonly prsMerged: number;
	readonly prsClosedUnmerged: number;
	readonly prsStillOpen: number;
	readonly items: WorkItemReportRow[];
}

export function buildCampaignReport(store: CampaignStateStore, campaignId: string): CampaignReport {
	if (store.campaigns.getCampaign(campaignId) === null) {
		throw new Error(`unknown campaign: ${campaignId}`);
	}

	const { prNumbersByWorkItem, prsOpened } = prNumbersByItem(store, campaignId);

	let prsMerged = 0;
	let prsClosedUnmerged = 0;
	const items: WorkItemReportRow[] = [];
	for (const item of store.campaigns.listWorkItems(campaignId)) {
		const row = workItemRow(store, item, prNumbersByWorkItem);
		if (row.outcome === "merged") prsMerged += 1;
		if (row.outcome === "closed_unmerged") prsClosedUnmerged += 1;
		items.push(row);
	}

	return {
		campaignId,
		prsOpened,
		prsMerged,
		prsClosedUnmerged,
		prsStillOpen: prsOpened - prsMerged - prsClosedUnmerged,
		items,
	};
}

/** PR number per work item from the campaign's PR identities, plus open count. */
function prNumbersByItem(
	store: CampaignStateStore,
	campaignId: string,
): { prNumbersByWorkItem: Map<string, number>; prsOpened: number } {
	const prNumbersByWorkItem = new Map<string, number>();
	let prsOpened = 0;
	for (const identity of store.events.listPrIdentities(campaignId)) {
		if (identity.prNumber === null) continue;
		prsOpened += 1;
		if (!prNumbersByWorkItem.has(identity.workItemId)) {
			prNumbersByWorkItem.set(identity.workItemId, identity.prNumber);
		}
	}
	return { prNumbersByWorkItem, prsOpened };
}

/** One work-item report row, derived from its row, actions, and ledger. */
function workItemRow(
	store: CampaignStateStore,
	item: WorkItemRow,
	prNumbersByWorkItem: Map<string, number>,
): WorkItemReportRow {
	const actions = store.actions.listActionsForWorkItem(item.id);
	const dispatchCount = actions.filter(
		(action) => action.actionType === WARREN_DISPATCH_ACTION_TYPE,
	).length;
	return {
		workItemId: item.id,
		issueRef: item.issueRef,
		prNumber: prNumbersByWorkItem.get(item.id) ?? null,
		outcome: item.outcome,
		followUpIterations: Math.max(0, dispatchCount - 1),
		openToTerminalMs:
			item.outcomeAtMs === null ? null : Math.max(0, item.outcomeAtMs - item.createdAtMs),
	};
}
