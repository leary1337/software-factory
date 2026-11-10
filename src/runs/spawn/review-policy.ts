import { parseAcceptanceCriteria } from "../../core/acceptance-evidence.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type { RunSpec } from "../../runtime/contract.ts";
import { readApprovedDefaults } from "./approved-defaults.ts";
import type { SpawnRunInput } from "./types.ts";

export async function readReviewGate(
	input: SpawnRunInput,
	project: ProjectRow,
): Promise<NonNullable<RunSpec["qualityGate"]>> {
	const defaults = await readApprovedDefaults(input, project);
	if (!defaults.qualityGate) throw new Error("Approved base branch must configure a quality gate.");
	return {
		command: defaults.qualityGate,
		commit: input.baseCommit ?? "",
		acceptance: {
			checks: [],
			enforce: false,
			requireBrowser: false,
			...defaults.acceptance,
			criteria: parseAcceptanceCriteria(input.prompt),
		},
	};
}
