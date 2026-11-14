import { ValidationError } from "../../core/errors.ts";
import { mergeProjectDefaults } from "../../projects/settings.ts";
import {
	assertExecutionProfile,
	profileForRole,
	resolveExecutionProfiles,
} from "../../runtime/adapters/execution-profiles.ts";
import { type DefaultsConfig, interactiveRuntimeOverride } from "../../warren-config/schema.ts";
import { readProjectDefaults, resolveOverride } from "./agent-cache.ts";
import type { SpawnRunInput } from "./types.ts";

export async function readDispatchDefaults(
	input: SpawnRunInput,
	project: { id: string; localPath: string },
): Promise<DefaultsConfig | null> {
	if (input.approvedDefaults !== undefined) return input.approvedDefaults;
	const defaults = await readProjectDefaults(input.warrenConfigs, project.id, project.localPath);
	const row = await input.repos.projectSettings.get(project.id);
	return row ? mergeProjectDefaults(defaults, row.settings) : defaults;
}

export function resolveDispatchProfile(input: SpawnRunInput, defaults: DefaultsConfig | null) {
	const profile =
		input.executionProfile ??
		(defaults?.executionProfiles
			? profileForRole(resolveExecutionProfiles(defaults), input.agentName)
			: undefined);
	const provider = resolveOverride(
		input.providerOverride,
		profile ? "openai" : defaults?.defaultProvider,
	);
	const model = resolveOverride(input.modelOverride, profile?.model ?? defaults?.defaultModel);
	if (profile) {
		assertExecutionProfile({ ...profile, model: model ?? profile.model });
		if (provider !== "openai")
			throw new ValidationError(
				"Codex profiles require ChatGPT authentication with the openai provider",
			);
	}
	return {
		provider,
		model,
		runtime: profile?.runtime ?? interactiveRuntimeOverride(input.agentName, defaults),
	};
}
