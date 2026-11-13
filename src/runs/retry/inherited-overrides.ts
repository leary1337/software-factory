import { readProviderFrontmatter } from "../../registry/schema.ts";

/** Override slots on `SpawnRunInput`, filled only where the parent had one. */
export interface InheritedDispatchOverrides {
	readonly providerOverride?: string;
	readonly modelOverride?: string;
}

/**
 * Read the three override slots off a failed run's rendered agent. A run
 * whose frontmatter carries none yields `{}`, so a spread of the result
 * leaves the retry resolving exactly as the original did.
 *
 * `renderedAgentJson` is `unknown` on the row, and a hand-built fixture or
 * an older row can carry anything, so the shape is narrowed rather than
 * asserted.
 */
export function inheritedDispatchOverrides(renderedAgentJson: unknown): InheritedDispatchOverrides {
	const frontmatter = readFrontmatter(renderedAgentJson);
	const provider = readProviderFrontmatter(frontmatter);
	return {
		...(provider.provider !== undefined ? { providerOverride: provider.provider } : {}),
		...(provider.model !== undefined ? { modelOverride: provider.model } : {}),
	};
}

function readFrontmatter(renderedAgentJson: unknown): Readonly<Record<string, unknown>> {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return {};
	const { frontmatter } = renderedAgentJson as { frontmatter?: unknown };
	if (frontmatter === null || typeof frontmatter !== "object") return {};
	return frontmatter as Readonly<Record<string, unknown>>;
}
