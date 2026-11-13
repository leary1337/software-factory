/** Validate the explicit contract required before dispatching automatic production delivery. */
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function validateDeploymentWorkflow(source: string, shaInput: string): boolean {
	let workflow: Record<string, unknown>;
	try {
		workflow = record(Bun.YAML.parse(source));
	} catch {
		return false;
	}
	const input = record(record(record(record(workflow.on).workflow_dispatch).inputs)[shaInput]);
	if (input.required !== true) return false;
	if (workflow["run-name"] !== `Factory deploy \${{ inputs.${shaInput} }}`) return false;
	const checkouts = Object.values(record(workflow.jobs)).flatMap((job) => {
		const steps = record(job).steps;
		return Array.isArray(steps)
			? steps
					.map(record)
					.filter(
						(step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
					)
			: [];
	});
	if (checkouts.length === 0) return false;
	const references = new Set([
		`\${{ inputs.${shaInput} }}`,
		`\${{ github.event.inputs.${shaInput} }}`,
	]);
	return checkouts.every((step) => references.has(String(record(step.with).ref).trim()));
}
