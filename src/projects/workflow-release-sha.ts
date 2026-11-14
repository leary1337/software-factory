const EXPORT_SHA = 'export GITHUB_SHA="$FACTORY_RELEASE_SHA"';
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function steps(data: Record<string, unknown>): Record<string, unknown>[] {
	return Object.values(record(data.jobs)).flatMap((value) => {
		const job = record(value);
		const values = job.steps;
		return Array.isArray(values) ? values.map(record) : [];
	});
}
function rewriteCommitExpressions(
	value: unknown,
	expression: string,
	seen = new WeakSet<object>(),
): void {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string")
			(value as Record<string, unknown>)[key] = entry.replace(
				/\$\{\{\s*github\.sha\s*\}\}/g,
				expression,
			);
		else rewriteCommitExpressions(entry, expression, seen);
	}
}
/** Actions' GITHUB_SHA names the dispatch branch, so application commands need an explicit SHA. */
export function pinReleaseCommands(data: Record<string, unknown>, shaInput: string): void {
	const expression = `\${{ inputs.${shaInput} }}`;
	rewriteCommitExpressions(data, expression);
	data.env = { ...record(data.env), FACTORY_RELEASE_SHA: expression };
	for (const step of steps(data)) {
		if (typeof step.run !== "string") continue;
		if (
			step.shell !== undefined &&
			(typeof step.shell !== "string" || !/^(bash|sh)(?:\s|$)/.test(step.shell))
		)
			throw new Error(
				"Cannot safely pin a non-POSIX deployment command; provide an explicit workflow contract",
			);
		let command = step.run.replace(
			/\$GITHUB_SHA\b|\$\{GITHUB_SHA\}|\$\{\{\s*github\.sha\s*\}\}/g,
			`\${FACTORY_RELEASE_SHA}`,
		);
		if (!command.startsWith(`${EXPORT_SHA}\n`)) command = `${EXPORT_SHA}\n${command}`;
		step.run = command;
	}
}
export function hasPinnedReleaseCommands(data: Record<string, unknown>, shaInput: string): boolean {
	const commands = steps(data).filter((step) => typeof step.run === "string");
	if (commands.length === 0) return true;
	if (record(data.env).FACTORY_RELEASE_SHA !== `\${{ inputs.${shaInput} }}`) return false;
	return commands.every(
		(step) =>
			typeof step.run === "string" &&
			step.run.startsWith(`${EXPORT_SHA}\n`) &&
			!/\$\{\{\s*github\.sha\s*\}\}/.test(step.run),
	);
}
