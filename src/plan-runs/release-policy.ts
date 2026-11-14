import type { Repos } from "../db/repos/index.ts";
import { loadEffectiveProjectConfig } from "../projects/settings.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { DefaultsConfigSchema } from "../warren-config/schema.ts";
import { loadApprovedPlan } from "./approval.ts";

export interface ReleasePolicyDeps {
	repos: Pick<Repos, "projects" | "projectSettings" | "planApprovals">;
	warrenConfigs?: WarrenConfigCache;
}
/** A running plan uses the owner's frozen delivery policy, including explicit stage boundaries. */
export async function releasePolicy(
	deps: ReleasePolicyDeps,
	planRunId: string,
	projectId: string,
	seq: number,
) {
	const approval = await loadApprovedPlan(deps.repos, planRunId);
	if (approval) {
		const settings = DefaultsConfigSchema.parse(approval.snapshot.settings);
		const task = approval.snapshot.tasks.find((task) => task.seq === seq);
		if (!task) throw new Error("The release task is missing from the approved plan");
		const lastOpen = approval.snapshot.tasks
			.filter((task) => task.initialStatus !== "closed")
			.at(-1);
		return {
			deploy: settings.deploy,
			boundary: task.releaseAfter || lastOpen?.seq === seq,
			approved: true,
		};
	}
	const project = await deps.repos.projects.require(projectId);
	const config = await loadEffectiveProjectConfig({
		project,
		settings: deps.repos.projectSettings,
		warrenConfigs: deps.warrenConfigs,
	});
	if (config.errors.length) throw new Error("Deployment configuration could not be read");
	return { deploy: config.defaults?.deploy, boundary: true, approved: false };
}
