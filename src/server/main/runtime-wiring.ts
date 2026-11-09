/** Resolves the runtime provider once at boot, the sole composition point. */

import type { EnvLike } from "../../client/config.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { resolveRuntimeProvider } from "../../runtime/registry.ts";

export interface ResolveBootRuntimeProviderInput {
	readonly env: EnvLike;
	/** Lets the drive loop stamp `runs.workspace_ready_at` through the domain. */
	readonly onWorkspaceReady?: (runId: string, at: Date) => void;
}

export function resolveBootRuntimeProvider(
	input: ResolveBootRuntimeProviderInput,
): RuntimeProvider {
	return resolveRuntimeProvider(
		input.onWorkspaceReady !== undefined ? { onWorkspaceReady: input.onWorkspaceReady } : {},
		input.env,
	);
}
