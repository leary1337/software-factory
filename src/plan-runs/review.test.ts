import { describe, expect, test } from "bun:test";
import { PlanRunSpawnDeferredError } from "./errors.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import {
	advanceReview,
	decideReviewStep,
	loadReviewStage,
	MAX_REWORKS,
	parseVerdict,
	type ReviewStepRecord,
	reviewStageOf,
} from "./review.ts";

const passed: ReviewStepRecord = {
	step: "review",
	state: "succeeded",
	resultText: "VERDICT: PASS",
};
const changes: ReviewStepRecord = {
	step: "review",
	state: "succeeded",
	resultText: "VERDICT: CHANGES\n1. a.go:1 wrong",
};
const reworked: ReviewStepRecord = { step: "rework", state: "succeeded", resultText: "done" };

describe("parseVerdict", () => {
	test("reads the verdict line", () => {
		expect(parseVerdict("VERDICT: PASS\nNotes: fine")).toBe("PASS");
		expect(parseVerdict("VERDICT: CHANGES\n1. bad")).toBe("CHANGES");
	});

	test("finds no verdict in prose", () => {
		expect(parseVerdict("I think the verdict: pass applies")).toBeNull();
	});
});

describe("decideReviewStep", () => {
	test("starts with a review", () => {
		expect(decideReviewStep([])).toEqual({ kind: "spawn", step: "review" });
	});

	test("waits for a running step", () => {
		expect(decideReviewStep([{ step: "review", state: "running", resultText: null }])).toEqual({
			kind: "wait",
		});
	});

	test("a PASS finishes the review", () => {
		expect(decideReviewStep([passed])).toMatchObject({ kind: "finished", outcome: "passed" });
	});

	test("CHANGES sends the findings to rework", () => {
		expect(decideReviewStep([changes])).toEqual({
			kind: "spawn",
			step: "rework",
			findings: changes.resultText as string,
		});
	});

	test("a finished rework goes back to review", () => {
		expect(decideReviewStep([changes, reworked])).toEqual({ kind: "spawn", step: "review" });
	});

	test("stops after the rework limit with the findings still open", () => {
		const steps = Array.from({ length: MAX_REWORKS }, () => [changes, reworked]).flat();
		expect(decideReviewStep([...steps, changes])).toMatchObject({
			kind: "finished",
			outcome: "changes_left",
		});
	});

	test("a failed step or a missing verdict is broken", () => {
		expect(decideReviewStep([{ step: "rework", state: "failed", resultText: null }])).toMatchObject(
			{ kind: "finished", outcome: "broken" },
		);
		expect(
			decideReviewStep([{ step: "review", state: "succeeded", resultText: "looks fine" }]),
		).toMatchObject({ kind: "finished", outcome: "broken" });
	});
});

describe("reviewStageOf", () => {
	test("names where the PR actually is", () => {
		expect(reviewStageOf([])).toBe("reviewing");
		expect(reviewStageOf([{ step: "review", state: "running", resultText: null }])).toBe(
			"reviewing",
		);
		expect(reviewStageOf([changes])).toBe("reworking");
		expect(reviewStageOf([changes, { step: "rework", state: "running", resultText: null }])).toBe(
			"reworking",
		);
		expect(reviewStageOf([changes, reworked])).toBe("reviewing");
		expect(reviewStageOf([passed])).toBe("ready_to_merge");
		expect(reviewStageOf([{ step: "rework", state: "failed", resultText: null }])).toBe(
			"needs_attention",
		);
	});
});

describe("advanceReview", () => {
	const run = { id: "run_a", branch: "factory/run_a", baseCommit: "abc" };
	const prUrl = "https://github.com/o/r/pull/1";

	function harness(agentName = "implementer", finished = false) {
		const spawned: unknown[] = [];
		const emitted: string[] = [];
		const comments: string[] = [];
		const input = {
			planRun: { id: "pr_1", projectId: "prj", agentName },
			child: { seq: 1, seedId: "s-1" },
			repos: {
				events: {
					listByRun: async () => [],
					listTail: async () => [],
					hasKind: async () => finished,
				},
				runs: { require: async () => ({}) },
			},
			getIssue: async () => ({ id: "s-1", status: "open", title: "T", description: "D" }),
			emit: async (_: string, kind: string) => {
				emitted.push(kind);
			},
			commentOnPr: async (_: string, body: string) => {
				comments.push(body);
			},
			spawn: async (arg: unknown) => {
				spawned.push(arg);
				return { runId: "run_r" };
			},
		} as unknown as HandleInFlightInput;
		return { input, spawned, emitted, comments };
	}

	test("starts the reviewer on the PR branch with the ticket in its prompt", async () => {
		const { input, spawned, emitted } = harness();
		const decision = await advanceReview(input, run as never, prUrl);
		expect(decision).toEqual({
			kind: "result",
			result: { kind: "dispatched", childRunId: "run_r" },
		});
		expect(spawned[0]).toMatchObject({ agentName: "reviewer", existingBranch: "factory/run_a" });
		expect((spawned[0] as { prompt: string }).prompt).toContain("Ticket s-1: T");
		expect(emitted).toEqual(["plan_run.review_step"]);
	});

	test("a PASS merges the PR when merging is on, and says so", async () => {
		const { input, comments } = harness();
		const merges: string[] = [];
		const withMerge = {
			...input,
			mergePassedPr: async (_: string, branch: string) => {
				merges.push(branch);
				return true;
			},
			repos: {
				...input.repos,
				events: {
					...input.repos.events,
					listByRun: async () => [
						{
							kind: "plan_run.review_step",
							payloadJson: { step: "review", stepRunId: "run_r" },
						},
					],
					listTail: async () => [{ payloadJson: { type: "result", result: "VERDICT: PASS" } }],
				},
				runs: {
					require: async () => ({ state: "succeeded", endedAt: "t", failureReason: null }),
				},
			},
		} as unknown as HandleInFlightInput;

		expect(await advanceReview(withMerge, run as never, prUrl)).toBeNull();
		expect(merges).toEqual(["factory/run_a"]);
		expect(comments[0]).toContain("слит автоматически");
	});

	test("leaves plans of other agents alone", async () => {
		const { input, spawned } = harness("claude-code");
		expect(await advanceReview(input, run as never, prUrl)).toBeNull();
		expect(spawned).toEqual([]);
	});

	test("a finished review hands the PR to the human", async () => {
		const { input, spawned, comments } = harness("implementer", true);
		expect(await advanceReview(input, run as never, prUrl)).toBeNull();
		expect(spawned).toEqual([]);
		expect(comments).toEqual([]);
	});

	test("keeps the stage readable when a Codex reviewer commits no changes", async () => {
		const { input } = harness();
		const repos = {
			...input.repos,
			events: {
				...input.repos.events,
				listByRun: async () => [
					{ kind: "plan_run.review_step", payloadJson: { step: "review", stepRunId: "r" } },
				],
				listTail: async () => [
					{ payloadJson: { type: "result", runtime: "codex", result: "VERDICT: PASS" } },
				],
			},
			runs: {
				require: async () => ({ state: "failed", failureReason: "no_changes", endedAt: "t" }),
			},
		} as unknown as HandleInFlightInput["repos"];
		expect(await loadReviewStage(repos, "implementer", "run_a")).toBe("ready_to_merge");
		expect(await loadReviewStage(repos, "pi", "run_a")).toBeNull();
	});

	test("waits for a running review and treats a missing final message as broken", async () => {
		const { input, comments } = harness();
		const repos = {
			...input.repos,
			events: {
				...input.repos.events,
				listByRun: async () => [
					{ kind: "plan_run.review_step", payloadJson: { step: "review", stepRunId: "r" } },
				],
			},
			runs: { require: async () => ({ state: "running", endedAt: null }) },
		} as unknown as HandleInFlightInput["repos"];
		expect(await advanceReview({ ...input, repos }, run as never, prUrl)).toMatchObject({
			result: { kind: "waiting_for_run" },
		});
		repos.runs.require = async () => ({ state: "succeeded", endedAt: "t" }) as never;
		expect(await advanceReview({ ...input, repos }, run as never, prUrl)).toBeNull();
		expect(comments[0]).toContain("no verdict");
	});

	test("reports a missing branch or failed dispatch without merging", async () => {
		const { input, comments } = harness();
		expect(await advanceReview(input, { ...run, branch: null } as never, prUrl)).toBeNull();
		expect(comments[0]).toContain("no branch");
		const failed = {
			...input,
			spawn: async () => {
				throw new Error("login expired");
			},
		};
		expect(await advanceReview(failed, run as never, prUrl)).toBeNull();
		expect(comments[1]).toContain("did not start");
	});

	test("defers a review when the shared concurrency budget is occupied", async () => {
		const { input, comments } = harness();
		const deferred = {
			...input,
			spawn: async () => {
				throw new PlanRunSpawnDeferredError("concurrency_limit");
			},
		};
		expect(await advanceReview(deferred, run as never, prUrl)).toMatchObject({
			result: { kind: "noop" },
		});
		expect(comments).toEqual([]);
	});
});
