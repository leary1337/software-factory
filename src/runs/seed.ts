/** Materialize the agent envelope, expertise and workflow for a new run. */
import { formatError } from "../core/errors.ts";
import type { AgentDefinition } from "../registry/schema.ts";
import type { RunSpec } from "../runtime/contract.ts";
import { AGENT_ENVELOPE_PATH } from "../workspace/git/exclude.ts";
import { RunSpawnError } from "./errors.ts";

/**
 * A provider-neutral workspace-seed file (warren-c42c). Shaped exactly like a
 * `RunSpec.seedFiles` entry so `buildSeedFiles` output threads straight onto
 * the runtime seam without importing burrow's `HttpWorkspaceFile`. Each backend
 * materializes the drops (LocalProvider → burrow's seed payload; K8sProvider →
 * an init container).
 */
export type SeedFile = RunSpec["seedFiles"][number];

export interface BuildSeedFilesResult {
	readonly files: readonly SeedFile[];
	readonly agentEnvelopePath: string;
	readonly mulchDomains: readonly string[];
	readonly workflowPath: string | null;
}

export function buildSeedFiles(agent: AgentDefinition): BuildSeedFilesResult {
	const files: SeedFile[] = [];

	const agentEnvelopePath = AGENT_ENVELOPE_PATH;
	files.push({
		path: agentEnvelopePath,
		contents: `${JSON.stringify(
			{
				name: agent.name,
				version: agent.version,
				sections: agent.sections,
				resolvedFrom: agent.resolvedFrom,
				frontmatter: agent.frontmatter,
			},
			null,
			2,
		)}\n`,
	});

	const { domains, files: mulchFiles } = buildExpertiseFiles(agent.sections.expertise_seed);
	files.push(...mulchFiles);

	const workflowFile = buildWorkflowFile(agent.sections.workflow);
	if (workflowFile !== null) files.push(workflowFile);

	return {
		files,
		agentEnvelopePath,
		mulchDomains: domains,
		workflowPath: workflowFile?.path ?? null,
	};
}

function buildExpertiseFiles(body: string | undefined): {
	domains: readonly string[];
	files: SeedFile[];
} {
	if (body === undefined || body.trim() === "") return { domains: [], files: [] };

	const grouped = new Map<string, string[]>();
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw === undefined) continue;
		const line = raw.trim();
		if (line === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new RunSpawnError(
				`expertise_seed line ${i + 1} is not valid JSON: ${formatError(err)}`,
				{ recoveryHint: "fix the canopy prompt's expertise_seed section" },
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new RunSpawnError(
				`expertise_seed line ${i + 1} is not a JSON object: ${truncate(line, 80)}`,
			);
		}
		const domain = (parsed as { domain?: unknown }).domain;
		if (typeof domain !== "string" || domain === "") {
			throw new RunSpawnError(`expertise_seed line ${i + 1} is missing a non-empty "domain" field`);
		}
		const bucket = grouped.get(domain) ?? [];
		bucket.push(line);
		grouped.set(domain, bucket);
	}

	const domains = [...grouped.keys()].sort();
	const files = domains.map((domain) => {
		const records = grouped.get(domain) ?? [];
		return { path: `.mulch/expertise/${domain}.jsonl`, contents: `${records.join("\n")}\n` };
	});
	return { domains, files };
}

function buildWorkflowFile(body: string | undefined): SeedFile | null {
	if (body === undefined || body.trim() === "") return null;
	return {
		path: ".seeds/workflow.txt",
		contents: body.endsWith("\n") ? body : `${body}\n`,
	};
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}…`;
}
