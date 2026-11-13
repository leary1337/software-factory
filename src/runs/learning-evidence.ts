import type { Repos } from "../db/repos/index.ts";

export interface LearningEvidence {
	readonly sourceKey: string;
	readonly trigger: string;
	readonly sourceRunId: string;
	readonly projectId: string;
	readonly planRunId?: string;
	readonly childSeq?: number;
	readonly report: string;
}

/** Persist an observation for a human retrospective, never an inferred root cause. */
export async function recordLearningEvidence(
	repos: Pick<Repos, "events">,
	emit: (
		runId: string,
		kind: "factory.learning",
		payload: Record<string, unknown>,
	) => Promise<unknown>,
	runId: string,
	evidence: LearningEvidence,
): Promise<void> {
	const events = await repos.events.listByRun(runId);
	if (
		events.some(
			(event) =>
				event.kind === "factory.learning" &&
				(event.payloadJson as { sourceKey?: unknown }).sourceKey === evidence.sourceKey,
		)
	)
		return;
	await emit(runId, "factory.learning", {
		...evidence,
		report: evidence.report.slice(0, 16000),
		interpretation: "Observed outcome. Investigate the source run before changing tests or rules.",
	});
}
