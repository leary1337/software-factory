import { z } from "zod";
import { ValidationError } from "../../core/errors.ts";
import type { ExecutionProfile, ExecutionProfiles } from "../../core/execution-profiles.ts";
import { KNOWN_RUNTIME_IDS } from "../../core/wire.ts";
import { CODEX_RUNTIME_ID } from "./codex.ts";
import { CODEX_DEFAULT_MODEL } from "./codex-config.ts";

const ProfileSchema = z
	.object({ runtime: z.enum(KNOWN_RUNTIME_IDS), model: z.string().trim().min(1).max(200) })
	.strict();
export const ExecutionProfilesSchema = z
	.object({ implementation: ProfileSchema, review: ProfileSchema })
	.strict();

export function executionOptions() {
	return [{ runtime: CODEX_RUNTIME_ID, label: "Codex", defaultModel: CODEX_DEFAULT_MODEL }];
}

/** Preserve explicit model IDs. Never substitute a model after validation fails. */
export function assertExecutionProfile(profile: ExecutionProfile): void {
	if (profile.runtime !== CODEX_RUNTIME_ID)
		throw new ValidationError("This installation currently enables Codex only");
	if (/^(claude-|gemini-|anthropic\/)|\//i.test(profile.model)) {
		throw new ValidationError(
			`Model ${profile.model} is incompatible with Codex ChatGPT authentication`,
		);
	}
}

export function resolveExecutionProfiles(
	defaults?: { executionProfiles?: ExecutionProfiles } | null,
): ExecutionProfiles {
	const profiles = defaults?.executionProfiles ?? {
		implementation: { runtime: CODEX_RUNTIME_ID, model: CODEX_DEFAULT_MODEL },
		review: { runtime: CODEX_RUNTIME_ID, model: CODEX_DEFAULT_MODEL },
	};
	assertExecutionProfile(profiles.implementation);
	assertExecutionProfile(profiles.review);
	return structuredClone(profiles);
}

export function profileForRole(profiles: ExecutionProfiles, role: string): ExecutionProfile {
	return role === "reviewer" ? profiles.review : profiles.implementation;
}
