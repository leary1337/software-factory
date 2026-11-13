import { expect, test } from "bun:test";
import type { RunRow } from "../db/schema.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import { finishReview } from "./review-delivery.ts";

test("keeps one escalation observation if delivery resumes after learning persisted", async () => {
	const events: { id: number; kind: string; payloadJson: unknown }[] = [
		{
			id: 1,
			kind: "plan_run.review_step",
			payloadJson: { step: "review", stepRunId: "review-source" },
		},
	];
	const input = {
		planRun: { id: "plan", projectId: "project" },
		child: { seq: 1 },
		repos: { events: { listByRun: async () => [...events] } },
		emit: async (_: string, kind: string, payloadJson: unknown) => {
			events.push({ id: events.length + 1, kind, payloadJson });
		},
	} as unknown as HandleInFlightInput;
	const run = { id: "implementation", branch: "branch" } as RunRow;
	await finishReview(input, run, "pr", "changes_left", "Still failing checks.");
	events.pop(); // Interruption before review_finished persists.
	await finishReview(input, run, "pr", "changes_left", "Still failing checks.");
	const lessons = events.filter((event) => event.kind === "factory.learning");
	expect(lessons).toHaveLength(1);
	expect(lessons[0]?.payloadJson).toMatchObject({
		sourceRunId: "review-source",
		sourceKey: "escalation:review-source:changes_left",
	});
});
