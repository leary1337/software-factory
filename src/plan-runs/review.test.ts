import { describe, expect, test } from "bun:test";
import type { QualityGateResult } from "../core/quality-gate.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import {
	advanceReview,
	decideReviewStep,
	describeGateForReviewer,
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
		expect(decideReviewStep([])).toEqual({ kind: "spawn", step: "review", gate: null });
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
			cause: "review",
		});
	});

	test("a finished rework goes back to review", () => {
		expect(decideReviewStep([changes, reworked])).toEqual({
			kind: "spawn",
			step: "review",
			gate: null,
		});
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

const greenGate: QualityGateResult = {
	command: "pnpm check",
	exitCode: 0,
	timedOut: false,
	durationMs: 95_000,
	sha: "abc123",
	logTail: "ok\n",
};
const redGate: QualityGateResult = {
	...greenGate,
	exitCode: 1,
	logTail: "Type error: x\n",
};

describe("decideReviewStep with the post-run gate", () => {
	test("a red implementer gate goes straight to rework without a reviewer", () => {
		const decision = decideReviewStep([], redGate);
		expect(decision).toMatchObject({ kind: "spawn", step: "rework", cause: "gate" });
		const findings = (decision as { findings: string }).findings;
		expect(findings).toContain("`pnpm check` exited with code 1 on commit abc123");
		expect(findings).toContain("Type error: x");
	});

	test("a green gate starts the review and hands the result to it", () => {
		expect(decideReviewStep([], greenGate)).toEqual({
			kind: "spawn",
			step: "review",
			gate: greenGate,
		});
	});

	test("a timed-out gate is red", () => {
		const decision = decideReviewStep([], { ...greenGate, exitCode: null, timedOut: true });
		expect(decision).toMatchObject({ kind: "spawn", step: "rework", cause: "gate" });
		expect((decision as { findings: string }).findings).toContain("was stopped after 1 min 35 s");
	});

	test("a gate warren could not start still goes to review", () => {
		const broken = { ...greenGate, exitCode: null, error: "spawn failed" };
		expect(decideReviewStep([], broken)).toMatchObject({ kind: "spawn", step: "review" });
	});

	test("judges a rework by its own gate, not the implementer's", () => {
		const fixed = { ...reworked, gate: greenGate };
		const stillRed = { ...reworked, gate: redGate };
		expect(decideReviewStep([fixed], redGate)).toMatchObject({ step: "review", gate: greenGate });
		expect(decideReviewStep([changes, stillRed], greenGate)).toMatchObject({
			step: "rework",
			cause: "gate",
		});
	});

	test("stops with the gate still red once the reworks run out", () => {
		const stillRed = { ...reworked, gate: redGate };
		const steps = Array.from({ length: MAX_REWORKS }, () => stillRed);
		expect(decideReviewStep(steps, redGate)).toMatchObject({
			kind: "finished",
			outcome: "changes_left",
		});
	});

	test("a red gate shows as reworking in the plan view", () => {
		expect(reviewStageOf([], redGate)).toBe("reworking");
	});
});

describe("describeGateForReviewer", () => {
	test("tells the reviewer not to rerun a green gate on unchanged code", () => {
		const text = describeGateForReviewer(greenGate);
		expect(text).toContain("on commit abc123, and it passed in 1 min 35 s");
		expect(text).toContain("git diff --quiet abc123 HEAD");
		expect(text).toContain("do not run the gate again");
	});

	test("asks the reviewer to run the gate when warren could not", () => {
		expect(describeGateForReviewer({ ...greenGate, exitCode: null, error: "no sh" })).toContain(
			"Run it yourself",
		);
		expect(describeGateForReviewer({ ...greenGate, sha: null })).toContain("Run it yourself");
		expect(describeGateForReviewer(null)).toBe("");
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

	function harness(agentName = "implementer", finished = false, gate?: QualityGateResult) {
		const gateRow =
			gate === undefined
				? undefined
				: { payloadJson: { type: "quality_gate", phase: "finished", ...gate } };
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
					latestOfKind: async () => gateRow,
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

	test("gives the reviewer the green gate warren already ran", async () => {
		const { input, spawned } = harness("implementer", false, greenGate);
		await advanceReview(input, run as never, prUrl);
		expect(spawned[0]).toMatchObject({ agentName: "reviewer" });
		expect((spawned[0] as { prompt: string }).prompt).toContain("do not run the gate again");
	});

	test("sends a red gate to rework and records why", async () => {
		const { input, spawned } = harness("implementer", false, redGate);
		const payloads: unknown[] = [];
		const recording = {
			...input,
			emit: async (_: string, _kind: string, payload: unknown) => {
				payloads.push(payload);
			},
		} as HandleInFlightInput;
		await advanceReview(recording, run as never, prUrl);
		expect(spawned[0]).toMatchObject({ agentName: "rework", existingBranch: "factory/run_a" });
		const prompt = (spawned[0] as { prompt: string }).prompt;
		expect(prompt).toContain("quality gate on the branch of");
		expect(prompt).toContain("Type error: x");
		expect(payloads[0]).toMatchObject({ step: "rework", cause: "gate" });
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
});
