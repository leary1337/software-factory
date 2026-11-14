import { describe, expect, test } from "bun:test";
import type { PlanRunDetailResponse, RunRow } from "@/api/types.ts";
import { standaloneStatus, standaloneTasks } from "./standalone-tasks.ts";
import { taskCopy } from "./task-copy.ts";
import { hasVerifiedRelease } from "./task-evidence.ts";

const run = (id: string, overrides: Partial<RunRow> = {}): RunRow =>
	({
		id,
		projectId: "project",
		state: "running",
		createdAt: Number(id),
		prompt: "Fix checkout\n\nShow the delivery date.",
		...overrides,
	}) as RunRow;
describe("standaloneTasks", () => {
	test("unifies retries and independent review into their original task", () => {
		const original = run("1");
		const retry = run("2", { retryOf: "1" });
		const review = run("3", { parentRunId: "2" });
		const tasks = standaloneTasks([review, retry, original, review], []);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.original).toBe(original);
		expect(tasks[0]?.current).toBe(review);
		expect(tasks[0]?.attempts).toHaveLength(3);
	});
	test("hides retired patrols and orphan technical jobs but retains attached review attempts", () => {
		const tasks = standaloneTasks(
			[
				run("1", { agentName: "nightwatch" }),
				run("2", { agentName: "reviewer" }),
				run("3", { agentName: "implementer" }),
				run("4", { agentName: "reviewer", parentRunId: "3" }),
			],
			[],
		);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.current.id).toBe("4");
	});
	test("keeps matching issue IDs scoped to their project", () => {
		expect(
			standaloneTasks(
				[run("1", { seedId: "same" }), run("2", { projectId: "other", seedId: "same" })],
				[],
			),
		).toHaveLength(2);
	});
	test("excludes planned executions and linked review attempts", () => {
		const detail = {
			planRun: { projectId: "project" },
			children: [{ seedId: "issue" }],
			runs: [run("1")],
		} as PlanRunDetailResponse;
		expect(
			standaloneTasks(
				[run("1"), run("2", { parentRunId: "1" }), run("3", { seedId: "issue" }), run("4")],
				[detail],
			).map((task) => task.original.id),
		).toEqual(["4"]);
	});
	test("handles cyclic parent links without duplicating or looping", () => {
		expect(
			standaloneTasks([run("1", { parentRunId: "2" }), run("2", { parentRunId: "1" })], []),
		).toHaveLength(1);
	});
	test("does not announce success from a successful execution or merge alone", () => {
		expect(standaloneStatus(run("1", { state: "succeeded", prMergedAt: "2026-01-01" })).group).toBe(
			"history",
		);
	});
});
describe("taskCopy", () => {
	test("shows the title and description without exposing the prompt disclosure", () => {
		expect(taskCopy("# Fix checkout\n\nShow the delivery date.")).toEqual({
			title: "Fix checkout",
			description: "Show the delivery date.",
		});
		expect(taskCopy(undefined, "Task title").description).toBe("Description not provided.");
	});
});
describe("hasVerifiedRelease", () => {
	test("requires a merged task and complete release evidence", () => {
		const productionVerification = {
			sha: "a".repeat(40),
			environment: "production",
			checks: { availability: true, version: true, scenario: true } as const,
			verifiedAt: "2026-01-01T00:00:00Z",
		};
		expect(hasVerifiedRelease({ state: "merged", productionVerification })).toBe(true);
		expect(hasVerifiedRelease({ state: "failed", productionVerification })).toBe(false);
		expect(
			hasVerifiedRelease({
				state: "merged",
				productionVerification: { ...productionVerification, sha: "abc" },
			}),
		).toBe(false);
		expect(
			hasVerifiedRelease({
				state: "merged",
				productionVerification: { ...productionVerification, verifiedAt: "invalid" },
			}),
		).toBe(false);
	});
});
