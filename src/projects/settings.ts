import { StateTransitionError, ValidationError } from "../core/errors.ts";
import type { ProjectSettingsRepo } from "../db/repos/project-settings.ts";
import { resolveExecutionProfiles } from "../runtime/adapters/execution-profiles.ts";
import {
	type LoadedWarrenConfig,
	loadWarrenConfig,
	type WarrenConfigCache,
} from "../warren-config/index.ts";
import { type DefaultsConfig, DefaultsConfigSchema } from "../warren-config/schema.ts";

interface SettingsInput {
	project: { id: string; localPath: string };
	settings: ProjectSettingsRepo;
	warrenConfigs?: WarrenConfigCache;
}

export function mergeProjectDefaults(
	defaults: DefaultsConfig | null,
	overrides: Record<string, unknown>,
): DefaultsConfig {
	const parsed = DefaultsConfigSchema.safeParse({ ...defaults, ...overrides });
	if (!parsed.success)
		throw new ValidationError(
			parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
		);
	if (parsed.data.executionProfiles) resolveExecutionProfiles(parsed.data);
	return parsed.data;
}

/** Durable operator settings take precedence over checked-in defaults after every refresh. */
async function readSettingsState(input: SettingsInput) {
	const { project, settings, warrenConfigs } = input;
	const loaded = warrenConfigs
		? await warrenConfigs.get(project.id, project.localPath)
		: await loadWarrenConfig({ projectPath: project.localPath });
	const row = await settings.get(project.id);
	return {
		row,
		loaded: row
			? { ...loaded, defaults: mergeProjectDefaults(loaded.defaults, row.settings) }
			: loaded,
	};
}

export async function loadEffectiveProjectConfig(
	input: SettingsInput,
): Promise<LoadedWarrenConfig> {
	return (await readSettingsState(input)).loaded;
}

export async function readProjectSettings(input: SettingsInput) {
	const { loaded, row } = await readSettingsState(input);
	return {
		revision: row?.revision ?? 0,
		overrides: row?.settings ?? {},
		effective: { ...loaded.defaults, executionProfiles: resolveExecutionProfiles(loaded.defaults) },
		errors: loaded.errors,
	};
}

/** Replace only requested top-level fields; omitted siblings remain untouched. */
export async function updateProjectSettings(
	input: SettingsInput & { revision: number; patch: Record<string, unknown> },
) {
	const current = await input.settings.get(input.project.id);
	if ((current?.revision ?? 0) !== input.revision)
		throw new StateTransitionError("Project settings changed. Reload before saving.");
	const next = { ...current?.settings, ...input.patch };
	mergeProjectDefaults(null, next);
	if (!(await input.settings.compareAndSet(input.project.id, input.revision, next))) {
		throw new StateTransitionError("Project settings changed. Reload before saving.");
	}
	return readProjectSettings(input);
}
