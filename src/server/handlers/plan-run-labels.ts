/** Human names for plans and tickets, read once from the tracker and remembered. */

import type { PlanCapableTracker } from "../../tracker/contract.ts";
import type { ServerDeps } from "../types.ts";

const remembered = new Map<string, string>();

async function remember(key: string, read: () => Promise<string | undefined>) {
	const known = remembered.get(key);
	if (known !== undefined) return known;
	try {
		const value = await read();
		if (value !== undefined && value !== "") remembered.set(key, value);
		return value ?? null;
	} catch {
		return null;
	}
}

async function trackerContext(deps: ServerDeps, projectId: string) {
	const project = await deps.repos.projects.require(projectId);
	return { projectId, localPath: project.localPath };
}

export function ticketTitle(deps: ServerDeps, projectId: string, seedId: string) {
	return remember(`${projectId}:${seedId}`, async () => {
		const issue = await deps.issueTracker?.getIssue(await trackerContext(deps, projectId), seedId);
		return issue?.title;
	});
}

export function planName(deps: ServerDeps, projectId: string, planId: string | null) {
	if (planId === null) return Promise.resolve(null);
	return remember(`${projectId}:${planId}`, async () => {
		const tracker = deps.issueTracker;
		if (tracker === undefined || !tracker.capabilities.supportsPlans) return undefined;
		const plans = tracker as unknown as PlanCapableTracker;
		const listed = await plans.listPlans(await trackerContext(deps, projectId));
		return listed.find((plan) => plan.id === planId)?.name;
	});
}
