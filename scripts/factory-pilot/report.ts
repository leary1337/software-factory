import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

export const PILOT_REPOSITORY = "leary1337/factory-sandbox";

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function field(value: unknown): string | null {
	return typeof value === "string" ? value.slice(0, 500) : null;
}

export function assertPilotRepository(gitUrl: string): void {
	const normalized = gitUrl
		.replace(/^git@github.com:/, "https://github.com/")
		.replace(/^ssh:\/\/git@github.com\//, "https://github.com/")
		.replace(/\.git$/, "");
	if (normalized !== `https://github.com/${PILOT_REPOSITORY}`)
		throw new Error(`Live pilot mutations are restricted to ${PILOT_REPOSITORY}.`);
}

/** No prompts, event bodies, credentials or artifact bytes enter the portable report. */
export function summarizePilot(value: unknown) {
	const detail = object(value);
	const plan = object(detail.planRun);
	return {
		planRunId: field(plan.id),
		state: field(plan.state),
		failureReason: field(plan.failureReason),
		children: array(detail.children).map((item) => {
			const child = object(item);
			const merge = object(child.reviewMerge);
			return {
				issueId: field(child.seedId),
				runId: field(child.runId),
				state: field(child.state),
				reviewStage: field(child.reviewStage),
				mergeKind: field(merge.kind),
				mergeReason: field(merge.reason),
				reviews: array(child.reviewSteps).map((item) => {
					const step = object(item);
					const summary = object(step.summary);
					const acceptance = object(summary.acceptance);
					return {
						runId: field(step.runId),
						step: field(step.step),
						executionState: field(step.executionState),
						verdict: field(summary.verdict),
						commit: field(summary.reviewedCommit),
						gateVerified: summary.gateVerified === true,
						acceptanceVerified: acceptance.verified === true,
						criteria: array(acceptance.criteria).map((item) => {
							const criterion = object(item);
							return {
								checkId: field(criterion.checkId),
								result: field(criterion.result),
								browser: criterion.browser === true,
								artifacts: array(criterion.artifacts).map((item) => {
									const artifact = object(item);
									return { path: field(artifact.path), sha256: field(artifact.sha256) };
								}),
							};
						}),
					};
				}),
			};
		}),
		runs: array(detail.runs).map((item) => {
			const run = object(item);
			return {
				id: field(run.id),
				state: field(run.state),
				agent: field(run.agentName),
				model: field(run.model),
				prUrl: field(run.prUrl),
				failureReason: field(run.failureReason),
			};
		}),
	};
}

export function pilotStopped(summary: ReturnType<typeof summarizePilot>): boolean {
	return (
		["succeeded", "failed", "cancelled"].includes(summary.state ?? "") ||
		summary.children.some(
			(child) => child.reviewStage === "needs_attention" || child.mergeKind === "blocked",
		)
	);
}

/** Hash tracked and nonignored source without staging changes or trusting the index contents. */
export async function fingerprintSource(
	cwd: string,
): Promise<{ head: string; sourceSha256: string }> {
	const run = async (args: string[]) => {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const text = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) throw new Error("Cannot fingerprint factory source.");
		return text;
	};
	const files = [
		...new Set(
			(await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
				.split("\0")
				.filter(Boolean),
		),
	].sort();
	const hash = createHash("sha256");
	for (const path of files) {
		const absolute = join(cwd, path);
		hash.update(`${path}\0`);
		const stat = await lstat(absolute).catch(() => null);
		if (stat === null) {
			hash.update("deleted\0");
			continue;
		}
		if (stat.isSymbolicLink()) hash.update(`link:${await readlink(absolute)}\0`);
		else if (stat.isFile()) {
			hash.update(`${stat.mode & 0o111}\0`);
			hash.update(await readFile(absolute));
		}
		hash.update("\0");
	}
	return { head: (await run(["rev-parse", "HEAD"])).trim(), sourceSha256: hash.digest("hex") };
}
