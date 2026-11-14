import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";
import type { ProjectDeploymentSettings } from "../core/release.ts";
import { validateDeploymentWorkflow } from "./deployment-workflow.ts";
import { pinReleaseCommands } from "./workflow-release-sha.ts";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function pinCheckouts(data: Record<string, unknown>, shaInput: string): number {
	let checkouts = 0;
	for (const job of Object.values(record(data.jobs))) {
		const steps = record(job).steps;
		if (!Array.isArray(steps)) continue;
		for (const value of steps) {
			const step = record(value);
			if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
				step.with = { ...record(step.with), ref: `\${{ inputs.${shaInput} }}` };
				checkouts++;
			}
		}
	}

	return checkouts;
}
function pinWorkflow(source: string, shaInput: string): string {
	const data = record(Bun.YAML.parse(source));
	const dispatch = record(record(data.on).workflow_dispatch);
	data.on = {
		workflow_dispatch: {
			...dispatch,
			inputs: {
				...record(dispatch.inputs),
				[shaInput]: {
					description: "Approved application commit",
					required: true,
					type: "string",
				},
			},
		},
	};
	data["run-name"] = `Factory deploy \${{ inputs.${shaInput} }}`;
	pinReleaseCommands(data, shaInput);
	const checkouts = pinCheckouts(data, shaInput);
	if (checkouts === 0)
		throw new Error(
			"Existing delivery has no checkout step; provide an explicitly pinned workflow before setup",
		);
	const result = dump(data, { lineWidth: -1, noRefs: true });
	if (!validateDeploymentWorkflow(result, shaInput))
		throw new Error("Cannot establish a pinned delivery workflow");

	return result;
}
/** Propose pinning through the existing delivery steps; changes remain reviewable in the setup PR. */
export async function prepareSetupWorkflow(
	workspace: string,
	config: ProjectDeploymentSettings | undefined,
): Promise<string[]> {
	if (!config?.autoDeploy) return [];
	if (!config.shaInput) throw new Error("Delivery requires a named commit input");
	const files = [
		{ workflow: config.workflow ?? "deploy.yml", shaInput: config.shaInput },
		...(config.rollback ? [config.rollback] : []),
	];
	const changed: string[] = [];
	for (const { workflow, shaInput } of files) {
		if (workflow.includes("/") || workflow.includes(".."))
			throw new Error("Choose an existing workflow filename");
		const path = join(workspace, ".github/workflows", workflow);
		const source = await readFile(path, "utf8");
		if (validateDeploymentWorkflow(source, shaInput)) continue;
		const result = pinWorkflow(source, shaInput);
		await writeFile(path, result);
		changed.push(`.github/workflows/${workflow}`);
	}
	return changed;
}
