import { isRetiredRuntimeId } from "../core/wire.ts";
import { AgentSchemaError } from "./errors.ts";
import { type AgentDefinition, readRuntimeId } from "./schema.ts";

/** Keep old definitions readable without offering them as executable choices. */
export function isRetiredAgent(row: { name: string; renderedJson: unknown }): boolean {
	const rendered = row.renderedJson;
	if (rendered === null || typeof rendered !== "object") return false;
	const frontmatter = (rendered as { frontmatter?: unknown }).frontmatter;
	const runtime =
		frontmatter !== null && typeof frontmatter === "object"
			? (frontmatter as { runtime?: unknown }).runtime
			: undefined;
	return isRetiredRuntimeId(runtime ?? row.name);
}

/** Resolve new work separately from decoding historical definitions. */
export function readRunnableRuntimeId(agent: AgentDefinition, configOverride?: string): string {
	const runtimeId = readRuntimeId(agent, configOverride);
	if (isRetiredRuntimeId(runtimeId) || isRetiredAgent({ name: agent.name, renderedJson: agent })) {
		throw new AgentSchemaError(
			`agent "${agent.name}" uses a retired runtime; select Codex or Claude Code`,
		);
	}
	return runtimeId;
}
