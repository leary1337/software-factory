import { describe, expect, test } from "bun:test";
import type { ReviewMergeResult } from "../core/review-merge.ts";
import type { RunRow } from "../db/schema.ts";
import type { HandleInFlightInput } from "./in-flight.ts";
import { finishReview } from "./review-delivery.ts";
import { loadReviewMergeResult } from "./review-summary.ts";

const COMMIT = "a".repeat(40);
const REPORT = `VERDICT: PASS\nREVIEWED_COMMIT: ${COMMIT}\nQUALITY_GATE: PASS\nCode accepted.`;
const BLOCKED = {
	kind: "blocked",
	reason: "protected_path",
	detail: "These changes require manual review.",
	nextAction: "Review the protected files and merge the pull request manually.",
	paths: ["scripts/check.sh"],
} as const;
const RETRY = {
	kind: "retry",
	reason: "network",
	detail: "The forge is temporarily unreachable.",
	nextAction: "Wait for an automatic retry.",
} as const;

function harness(merge: () => Promise<ReviewMergeResult>) {
	const events: { kind: string; payloadJson: Record<string, unknown> }[] = [];
	const run = { id: "implementation", branch: "work" } as RunRow;
	let calls = 0;
	const comments: string[] = [];
	const input = {
		repos: { events: { listByRun: async () => events } },
		planRun: { id: "plan", projectId: "project" },
		child: { seq: 1 },
		emit: async (_id: string, kind: string, payloadJson: Record<string, unknown>) => {
			events.push({ kind, payloadJson });
		},
		mergePassedPr: async () => {
			calls++;
			return merge();
		},
		commentOnPr: async (_url: string, body: string) => {
			comments.push(body);
		},
	} as unknown as HandleInFlightInput;
	const tick = () => finishReview(input, run, "https://github.com/o/r/pull/1", "passed", REPORT);
	return { input, run, events, tick, comments, calls: () => calls };
}

describe("review merge delivery", () => {
	test("persists policy refusals once with affected paths and the operator action", async () => {
		const h = harness(async () => BLOCKED);
		await h.tick();
		await h.tick();
		expect(h.calls()).toBe(1);
		expect(await loadReviewMergeResult(h.input.repos, h.run.id)).toEqual(BLOCKED);
		expect(h.comments).toHaveLength(1);
		expect(h.comments[0]).toContain("scripts/check.sh");
		expect(h.comments[0]).toContain(BLOCKED.nextAction);
		expect(h.events.find((e) => e.kind === "plan_run.review_finished")?.payloadJson).toMatchObject({
			outcome: "broken",
		});
	});

	test("retries transient failures and publishes success after recovery", async () => {
		let attempts = 0;
		const h = harness(async () => (++attempts === 1 ? RETRY : { kind: "merged" }));
		expect(await h.tick()).toMatchObject({ kind: "result" });
		expect(await loadReviewMergeResult(h.input.repos, h.run.id)).toEqual(RETRY);
		await h.tick();
		expect(h.calls()).toBe(2);
		expect(await loadReviewMergeResult(h.input.repos, h.run.id)).toEqual({ kind: "merged" });
		expect(h.comments).toHaveLength(1);
	});

	test("bounds transient retries while retaining the original failure reason", async () => {
		const h = harness(async () => RETRY);
		for (let index = 0; index < 6; index++) await h.tick();
		expect(h.calls()).toBe(3);
		expect(await loadReviewMergeResult(h.input.repos, h.run.id)).toMatchObject({
			kind: "blocked",
			reason: "network",
			detail: RETRY.detail,
		});
		expect(h.comments[0]).toContain("3 attempts");
	});

	test("does not classify an unknown thrown failure as safe to retry or expose its text", async () => {
		const h = harness(async () => {
			throw new Error("sensitive transport credential");
		});
		await h.tick();
		await h.tick();
		expect(h.calls()).toBe(1);
		expect(await loadReviewMergeResult(h.input.repos, h.run.id)).toMatchObject({
			kind: "blocked",
			reason: "unexpected_error",
		});
		expect(JSON.stringify(h.events)).not.toContain("sensitive");
	});

	test("retains a refusal across interrupted comment delivery", async () => {
		const h = harness(async () => BLOCKED);
		let comments = 0;
		h.input = {
			...h.input,
			commentOnPr: async () => {
				if (++comments === 1) throw new Error("comment interrupted");
			},
		};
		await expect(finishReview(h.input, h.run, "pr", "passed", REPORT)).rejects.toThrow(
			"comment interrupted",
		);
		await finishReview(h.input, h.run, "pr", "passed", REPORT);
		expect(h.calls()).toBe(1);
		expect(comments).toBe(2);
	});

	test("clears the displayed refusal when a fresh review starts", async () => {
		const h = harness(async () => BLOCKED);
		await h.tick();
		h.events.push({ kind: "plan_run.review_step", payloadJson: { stepRunId: "review-two" } });
		expect(await loadReviewMergeResult(h.input.repos, h.run.id)).toBeNull();
	});
});
