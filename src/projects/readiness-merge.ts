import type { Forge, RepoRef } from "../forge/contract.ts";
import type { AutoMergeConfig } from "../warren-config/pr-config.ts";
/** Exercise the same forge proof used at merge; a configured policy alone proves no capability. */
export async function checkMergeReadiness(input: {
	forge: Forge;
	gitUrl: string;
	branch: string;
	commit: string;
	policy: AutoMergeConfig | undefined;
}): Promise<string> {
	const { forge, policy } = input;
	if (!policy) throw new Error("Choose and configure the reviewed merge policy");
	const ref = forge.parseRepoRef(input.gitUrl);
	if (!ref) throw new Error("This forge cannot resolve the project's merge target");
	if (policy.verification === "warren") return checkWarrenMerge(forge, ref, input.commit, policy);
	if (!forge.capabilities.autoMergeArm || !forge.readMergeProtection)
		throw new Error(
			"The forge cannot verify automatic merge protection; choose supported merge checks",
		);
	const protection = await forge.readMergeProtection(ref, input.branch);
	if (!protection.ok || !protection.value.requiresUpToDate)
		throw new Error(
			"Strict up-to-date merge protection is not enforced; configure protection or choose Warren verification",
		);
	if (protection.value.baseCommit !== input.commit)
		throw new Error("The target branch changed; refresh the project before checking readiness");
	return "Strict merge protection and the current target commit are verified";
}

async function checkWarrenMerge(
	forge: Forge,
	ref: RepoRef,
	commit: string,
	policy: AutoMergeConfig,
): Promise<string> {
	if (!forge.readMergeChecks || !policy.requiredChecks?.length)
		throw new Error(
			"Warren merge requires a complete check reader and explicit required check names",
		);
	const checks = await forge.readMergeChecks(ref, commit);
	if (!checks.ok || checks.value.conclusion === "unknown")
		throw new Error("Cannot read complete repository check evidence for the selected commit");
	const names = new Set(checks.value.runs.map((run) => run.name));
	if (!policy.requiredChecks.every((name) => names.has(name)))
		throw new Error("Configured required checks are not present on the selected commit");
	return "Independent Warren verification can read all configured repository checks";
}
