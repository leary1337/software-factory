/**
 * `GET /projects/:id/warren-config` (warren-435b / warren-b754), split
 * from `projects.ts` for the 500-line budget (check:size). Carries the
 * per-project `.warren/` envelope handler and the public-projection
 * field classification: the narrowed spectator body is built from the
 * `PUBLIC_WARREN_CONFIG_*` allowlists and drops `triggers` (prompt
 * text), `prTemplate`, `errors`, and the operator-only default blocks.
 */

import type { ProjectRow } from "../../projects/index.ts";
import { loadEffectiveProjectConfig } from "../../projects/settings.ts";
import type { DefaultsConfig, LoadedWarrenConfig } from "../../warren-config/index.ts";
import { isPublicOnly, pickFields } from "../projection.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";

/**
 * The `.warren/` envelope keys a spectator is served by the narrowed
 * `GET /projects/:id/warren-config` envelope (warren-b754). `defaults`
 * is carried narrowed — see `PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS`.
 */
export const PUBLIC_WARREN_CONFIG_FIELDS = [
	"defaults",
	"sourceFile",
	"warnings",
] as const satisfies readonly (keyof LoadedWarrenConfig)[];

export const PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS = [
	"defaultRole",
	"defaultBranch",
	"defaultProvider",
	"defaultModel",
	"runBranchPrefix",
] as const satisfies readonly (keyof DefaultsConfig)[];

export const REDACTED_WARREN_CONFIG_FIELDS = [
	"triggers",
	"prTemplate",
	"errors",
	"defaultPrompt",
	"repoContext",
	"qualityGate",
	"acceptance",
	"planRunBudget",
	"taskBudgets",
	"preparation",
	"memoryEnabled",
	"migrations",
	"deploy",
	"agentImage",
	"preview",
	"agent",
	"interactiveAgents",
	"executionProfiles",
	"resources",
	"admission",
	"ciFixer",
	"healer",
	"tracker",
	"pr",
] as const satisfies readonly (keyof LoadedWarrenConfig | keyof DefaultsConfig)[];

/**
 * The one load path for the per-project `.warren/` envelope: project
 * 404 via `projects.require`, then the boot-wired cache when present,
 * a direct read otherwise. Shared by every warren-config reader in
 * `projects.ts` / this module. `require` throws NotFoundError → 404
 * via renderError; the cache only knows ids it's been asked about, so
 * the project lookup has to come first to keep the 404 contract honest.
 */
export async function loadProjectWarrenConfig(
	deps: ServerDeps,
	id: string,
): Promise<{ project: ProjectRow; loaded: LoadedWarrenConfig }> {
	const project = await deps.repos.projects.require(id);
	const loaded = await loadEffectiveProjectConfig({
		project,
		settings: deps.repos.projectSettings,
		warrenConfigs: deps.warrenConfigs,
	});
	return { project, loaded };
}

export function getProjectWarrenConfigHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const { loaded } = await loadProjectWarrenConfig(deps, id);
		// warren-b754: the operator body carries triggers (prompt text) and
		// errors (file-read narration); a spectator gets the narrowed
		// envelope — defaults allowlist only, everything else dropped.
		if (isPublicOnly(ctx.actor)) {
			return jsonResponse(200, {
				defaults:
					loaded.defaults === null
						? null
						: pickFields(loaded.defaults, PUBLIC_WARREN_CONFIG_DEFAULTS_FIELDS),
				sourceFile: loaded.sourceFile,
				warnings: loaded.warnings,
			});
		}
		return jsonResponse(200, {
			triggers: loaded.triggers,
			defaults: loaded.defaults,
			sourceFile: loaded.sourceFile,
			errors: loaded.errors,
			warnings: loaded.warnings,
		});
	};
}
