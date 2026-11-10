import type { Repos } from "../../db/repos/index.ts";

/** Compose role instructions, optional repository onboarding and the task. */
export function composeDispatchPrompt(
	systemBody: string | undefined,
	userPrompt: string,
	repoContext?: string,
): string {
	const trimmed = (systemBody ?? "").trim();
	// warren-540f: the project's `.warren/config.yaml` `repoContext` block
	// rides between the system section and the user prompt, clearly
	// delimited. Absent/whitespace-only → byte-identical to the pre-540f
	// composition.
	const context = (repoContext ?? "").trim();
	const parts = [trimmed, context].filter((part) => part !== "");
	if (parts.length === 0) return userPrompt;
	return `${parts.join("\n\n---\n\n")}\n\n---\n\n${userPrompt}`;
}

interface PromptSegments {
	readonly system: string;
	readonly repository: string;
	readonly task: string;
	readonly finalPrompt: string;
}

export function measureContext(segments: PromptSegments) {
	const measure = (value: string) => {
		const bytes = Buffer.byteLength(value, "utf8");
		return { bytes, estimatedTokens: Math.ceil(bytes / 4) };
	};
	return {
		method: "UTF-8 bytes; estimated tokens = ceil(bytes / 4), not model usage",
		system: measure(segments.system.trim()),
		repository: measure(segments.repository.trim()),
		task: measure(segments.task),
		finalPrompt: measure(segments.finalPrompt),
		skills:
			"Loaded on demand from the skill pack; disk contents are not counted as injected context.",
	};
}

/** Content-free accounting; failure to record telemetry never loses a dispatch. */
export async function recordContextMetrics(
	repos: Pick<Repos, "events">,
	runId: string,
	segments: PromptSegments,
	now: Date,
): Promise<void> {
	try {
		await repos.events.append({
			runId,
			sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
			ts: now.toISOString(),
			kind: "context.metrics",
			stream: "system",
			payload: measureContext(segments),
		});
	} catch {
		// Telemetry is optional; task execution is not.
	}
}
