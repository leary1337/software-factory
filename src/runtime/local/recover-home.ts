import { waitForSandboxStop } from "../../sandbox/guarded-process.ts";
import { RUNTIME_ADAPTERS } from "../adapters/index.ts";
import type { AgentRuntimeAdapter } from "../adapters/types.ts";
import type { LocalRunManifest } from "./manifest.ts";
import { waitForPreviewProcesses } from "./preview/process.ts";

/** Resolve harness-specific recovery through the same adapter seam as preparation. */
export async function recoverLocalHome(
	manifest: LocalRunManifest,
	registry?: { get(id: string): AgentRuntimeAdapter | undefined },
): Promise<void> {
	if (manifest.runtimeId === undefined && manifest.source.kind === "private") {
		throw new Error(
			"Run predates process supervision; stop its processes and recover the workspace manually",
		);
	}
	await waitForSandboxStop(`${manifest.homePath}.lifecycle.json`);
	await waitForPreviewProcesses(manifest.homePath);
	const adapter =
		manifest.runtimeId === undefined
			? undefined
			: (registry?.get(manifest.runtimeId) ??
				Object.values(RUNTIME_ADAPTERS).find((item) => item.runtimeId === manifest.runtimeId));
	await adapter?.recoverHome?.(manifest.homePath);
}
