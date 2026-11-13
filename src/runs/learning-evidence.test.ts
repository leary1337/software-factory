import { describe, expect, test } from "bun:test";
import type { Repos } from "../db/repos/index.ts";
import { recordLearningEvidence } from "./learning-evidence.ts";

describe("recordLearningEvidence", () => {
	test("records source evidence once across retries and preserves distinct incidents", async () => {
		const events: { kind: string; payloadJson: unknown }[] = [];
		const repos = { events: { listByRun: async () => events } } as unknown as Pick<Repos, "events">;
		const emit = async (_: string, kind: string, payloadJson: unknown) => {
			events.push({ kind, payloadJson });
		};
		const evidence = {
			sourceKey: "review-1",
			trigger: "rework",
			sourceRunId: "run_1",
			projectId: "project",
			report: "The test command failed.",
		};
		await recordLearningEvidence(repos, emit, "implementation", evidence);
		await recordLearningEvidence(repos, emit, "implementation", evidence);
		await recordLearningEvidence(repos, emit, "implementation", {
			...evidence,
			sourceKey: "review-2",
		});
		expect(events).toHaveLength(2);
		expect(events[0]?.payloadJson).toMatchObject({ report: evidence.report, sourceRunId: "run_1" });
	});
});
