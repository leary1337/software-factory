import { describe, expect, test } from "bun:test";
import type { RunRow } from "../db/schema.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import { advanceReview, decideReviewStep, type ReviewStepRecord } from "./review.ts";
import { includeUiReview, touchesUi } from "./ui-review.ts";

const SHA = "a".repeat(40);
const REPORT = `VERDICT: PASS\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: PASS\nNo findings.`;
const passed: ReviewStepRecord = {
	step: "review",
	state: "succeeded",
	resultText: REPORT,
	reviewedCommit: SHA,
	gateVerified: true,
};

describe("includeUiReview", () => {
	test("recognizes rendered-interface changes without treating backend code as UI", () => {
		expect(touchesUi(["src/ui/view.ts", "README.md"])).toBe(true);
		expect(touchesUi(["web/index.html"])).toBe(true);
		expect(touchesUi(["src/server/handler.ts", "main.go"])).toBe(false);
	});
	test("adds a separate UI review only after code passes and waits on an unreadable diff", async () => {
		const decision = decideReviewStep([passed]);
		const input = (paths: readonly string[] | null) =>
			({
				planRun: { projectId: "project" },
				getReviewChangedPaths: async () => paths,
			}) as unknown as HandleInFlightInput;
		expect(await includeUiReview(input(["screen.tsx"]), "branch", "url", passed, decision)).toEqual(
			{ kind: "spawn", step: "ui_review", reviewedCommit: SHA },
		);
		expect(await includeUiReview(input(["main.go"]), "branch", "url", passed, decision)).toEqual(
			decision,
		);
		expect(await includeUiReview(input(null), "branch", "url", passed, decision)).toEqual({
			kind: "wait",
		});
		expect(
			await includeUiReview(
				input(["screen.tsx"]),
				"branch",
				"url",
				{ ...passed, step: "ui_review" },
				decision,
			),
		).toEqual(decision);
	});
	test("routes UI findings through the same bounded rework loop", () => {
		const changes = {
			...passed,
			step: "ui_review" as const,
			resultText: REPORT.replace("VERDICT: PASS", "VERDICT: CHANGES"),
		};
		expect(decideReviewStep([passed, changes]).kind).toBe("spawn");
		const rework: ReviewStepRecord = { step: "rework", state: "succeeded", resultText: null };
		expect(decideReviewStep([rework, rework, changes])).toMatchObject({
			kind: "finished",
			outcome: "changes_left",
		});
	});
	test("pins and dispatches the UI reviewer before any merge", async () => {
		const spawned: { agentName: string; prompt: string; baseCommit: string }[] = [];
		let merged = false;
		const input = {
			planRun: { id: "plan", projectId: "project", agentName: "implementer" },
			child: { seq: 1, seedId: "task" },
			getReviewHead: async () => SHA,
			getReviewChangedPaths: async () => ["view.tsx"],
			getIssue: async () => ({
				id: "task",
				title: "Show status",
				description: "Render the result.",
			}),
			mergePassedPr: async () => {
				merged = true;
				return { kind: "merged" as const };
			},
			emit: async () => {},
			spawn: async (spec: { agentName: string; prompt: string; baseCommit: string }) => {
				spawned.push(spec);
				return { runId: "ui-review" };
			},
			repos: {
				runs: {
					require: async () => ({
						id: "code-review",
						state: "succeeded",
						failureReason: null,
						baseCommit: SHA,
					}),
				},
				events: {
					listByRun: async (id: string) =>
						id === "implementation"
							? [
									{
										kind: "plan_run.review_step",
										payloadJson: { step: "review", stepRunId: "code-review", reviewedCommit: SHA },
									},
								]
							: [
									{
										kind: "quality_gate.completed",
										stream: "system",
										payloadJson: { commit: SHA, command: "check", exitCode: 0 },
									},
								],
					listTail: async () => [{ payloadJson: { type: "result", result: REPORT } }],
				},
			},
		} as unknown as HandleInFlightInput;
		await advanceReview(
			input,
			{ id: "implementation", branch: "branch", baseCommit: SHA } as RunRow,
			"url",
		);
		expect(merged).toBe(false);
		expect(spawned[0]).toMatchObject({ agentName: "reviewer", baseCommit: SHA });
		expect(spawned[0]?.prompt).toContain("separate UI/UX review");
		// The head moves after selecting UI review but before its dispatch pin.
		let headReads = 0;
		spawned.length = 0;
		const moved = "b".repeat(40);
		await advanceReview(
			{ ...input, getReviewHead: async () => (++headReads === 1 ? SHA : moved) },
			{ id: "implementation", branch: "branch", baseCommit: SHA } as RunRow,
			"url",
		);
		expect(merged).toBe(false);
		expect(spawned[0]?.baseCommit).toBe(moved);
		expect(spawned[0]?.prompt).not.toContain("separate UI/UX review");
	});
});
