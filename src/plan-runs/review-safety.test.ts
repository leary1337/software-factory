import { afterEach, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { cancelPlanRun } from "./cancel.ts";
import { advancePlanRun, type CoordinatorSpawnInput } from "./coordinator.ts";
import { type HandleInFlightInput, handleInFlight } from "./in-flight.ts";
import { advanceReview, decideReviewStep, loadReviewStage, parseVerdict } from "./review.ts";

const SHA = "a".repeat(40);
const REPORT = `VERDICT: PASS\nREVIEWED_COMMIT: ${SHA}\nQUALITY_GATE: PASS\n\nAll checks passed.`;
const databases: WarrenDb[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) await db.close();
});

async function harness() {
	const db = await openDatabase({ path: ":memory:" });
	databases.push(db);
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/o/r",
		localPath: "/tmp/review",
		defaultBranch: "main",
		hasSeeds: true,
	});
	const created = await repos.planRuns.create({
		planId: "pl-review",
		projectId: project.id,
		agentName: "implementer",
		children: [{ seq: 1, seedId: "s-1" }],
	});
	const planRun = await repos.planRuns.transitionTo(created.planRun.id, "running");
	const createdRun = await repos.runs.create({
		agentName: "implementer",
		projectId: project.id,
		prompt: "build",
		renderedAgentJson: {},
		trigger: "plan-run",
	});
	const run = await repos.runs.setBranch(createdRun.id, "factory/work");
	await repos.runs.markRunning(run.id);
	await repos.runs.finalize(run.id, "succeeded");
	await repos.planRuns.updateChild({
		planRunId: planRun.id,
		seq: 1,
		patch: { runId: run.id, state: "dispatched" },
	});
	const child = await repos.planRuns.updateChild({
		planRunId: planRun.id,
		seq: 1,
		patch: { state: "pr_open" },
	});
	const reviewer = await repos.runs.create({
		agentName: "reviewer",
		projectId: project.id,
		prompt: "review",
		renderedAgentJson: {},
		trigger: "plan-run",
		baseCommit: SHA,
	});
	const emit = async (runId: string, kind: string, payload: Record<string, unknown>) => {
		await repos.events.append({
			runId,
			kind,
			stream: "system",
			ts: new Date().toISOString(),
			sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
			payload,
		});
	};
	await emit(run.id, "plan_run.review_step", {
		step: "review",
		stepRunId: reviewer.id,
		reviewedCommit: SHA,
	});
	const input = {
		planRun,
		child,
		repos,
		emit,
		getReviewHead: async () => SHA,
		getIssue: async () => ({ id: "s-1", title: "Ticket", description: "Work", status: "open" }),
		spawn: async () => {
			throw new Error("unexpected spawn");
		},
		checkPrMerged: async () => ({ kind: "open" }),
		now: () => new Date(),
		mergeTimeoutMs: 0,
		mergeStallWarningMs: 0,
	} as unknown as HandleInFlightInput;
	async function complete(report = REPORT, gate = true) {
		await repos.runs.markRunning(reviewer.id);
		await repos.runs.attachStats(reviewer.id, { costUsd: 0 });
		await repos.runs.finalize(reviewer.id, "succeeded");
		await emit(reviewer.id, "state_change", { type: "result", result: report });
		if (gate)
			await emit(reviewer.id, "quality_gate.completed", {
				commit: SHA,
				command: "./scripts/check.sh",
				exitCode: 0,
			});
	}
	return { input, repos, run, reviewer, planRun, complete };
}

test("rejects quoted, ambiguous and incomplete PASS reports", () => {
	for (const report of [
		"Example:\nVERDICT: PASS",
		"VERDICT: PASS later",
		"VERDICT: PASS\nVERDICT: CHANGES",
	])
		expect(parseVerdict(report)).toBeNull();
	for (const report of [
		"VERDICT: PASS",
		`${REPORT}\nNot run: tests`,
		REPORT.replace("QUALITY_GATE: PASS", "QUALITY_GATE: NOT_RUN"),
	]) {
		expect(
			decideReviewStep([{ step: "review", state: "succeeded", resultText: report }]),
		).toMatchObject({ kind: "finished", outcome: "broken" });
	}
});

test("cancels a review after the implementation has finished", async () => {
	const h = await harness();
	const result = await cancelPlanRun({
		planRunId: h.planRun.id,
		repos: h.repos,
		runtimeProvider: { kind: "stub" } as unknown as RuntimeProvider,
	});
	expect(result.cancelledChild?.runId).toBe(h.reviewer.id);
	expect((await h.repos.runs.require(h.reviewer.id)).state).toBe("cancelled");
});

test("retries merge after an interrupted completion and publishes the report once", async () => {
	const h = await harness();
	await h.complete();
	let merges = 0;
	let comments = 0;
	const input = {
		...h.input,
		mergePassedPr: async () => {
			merges++;
			if (merges === 1)
				return {
					kind: "retry" as const,
					reason: "network",
					detail: "Network unavailable.",
					nextAction: "Wait for the automatic retry.",
				};
			return { kind: "merged" as const };
		},
		commentOnPr: async () => {
			comments++;
		},
	};
	await advanceReview(input, h.run, "https://github.com/o/r/pull/1").catch(() => {});
	await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
	await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
	expect(merges).toBe(2);
	expect(comments).toBe(1);
});

test("refuses a report for a different commit", async () => {
	const h = await harness();
	await h.complete(REPORT.replace(SHA, "b".repeat(40)));
	let merges = 0;
	await advanceReview(
		{
			...h.input,
			mergePassedPr: async () => {
				merges++;
				return { kind: "merged" as const };
			},
		},
		h.run,
		"https://github.com/o/r/pull/1",
	);
	expect(merges).toBe(0);
});

test("finishes report delivery after the PR merged during an interrupted tick", async () => {
	const h = await harness();
	await h.complete();
	await h.repos.runs.setPrUrl(h.run.id, "https://github.com/o/r/pull/1");
	let comments = 0;
	const input = {
		...h.input,
		mergePassedPr: async () => ({ kind: "merged" as const }),
		commentOnPr: async () => {
			comments++;
			if (comments === 1) throw new Error("connection lost");
		},
	};
	await advanceReview(input, h.run, "https://github.com/o/r/pull/1").catch(() => {});
	expect(await h.repos.events.hasKind(h.run.id, "plan_run.review_finished")).toBe(false);
	await handleInFlight({
		...input,
		checkPrMerged: async () => ({ kind: "merged", mergedAt: new Date().toISOString() }),
	});
	expect(comments).toBe(2);
	expect(await h.repos.events.hasKind(h.run.id, "plan_run.review_finished")).toBe(true);
});

test("stops merge retries and exposes owner attention after three refusals", async () => {
	const h = await harness();
	await h.complete();
	let merges = 0;
	const input = {
		...h.input,
		mergePassedPr: async () => {
			merges++;
			return {
				kind: "retry" as const,
				reason: "network",
				detail: "Network unavailable.",
				nextAction: "Wait for the automatic retry.",
			};
		},
	};
	for (let tick = 0; tick < 6; tick++)
		await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
	expect(merges).toBe(3);
	expect(await loadReviewStage(h.repos, "implementer", h.run.id)).toBe("needs_attention");
});

test.each(["PASS", "CHANGES", "finished CHANGES", "failed rework"])(
	"pins a fresh review when the PR head moves after %s",
	async (scenario) => {
		const h = await harness();
		await h.complete(
			scenario === "PASS" ? REPORT : REPORT.replace("VERDICT: PASS", "VERDICT: CHANGES"),
		);
		let merges = 0;
		if (scenario === "failed rework") {
			const rework = await h.repos.runs.create({
				agentName: "rework",
				projectId: h.planRun.projectId,
				prompt: "fix",
				trigger: "plan-run",
				renderedAgentJson: {},
			});
			await h.repos.runs.markRunning(rework.id);
			await h.repos.runs.attachStats(rework.id, { costUsd: 0 });
			await h.repos.runs.finalize(rework.id, "failed", new Date(), "crashed");
			await h.input.emit(h.run.id, "plan_run.review_step", {
				step: "rework",
				stepRunId: rework.id,
			});
			await h.input.emit(h.run.id, "plan_run.review_finished", { outcome: "broken" });
			expect(await advanceReview(h.input, h.run, "https://github.com/o/r/pull/1")).toBeNull();
		}
		if (scenario === "finished CHANGES") {
			await h.input.emit(h.run.id, "plan_run.review_decided", {
				outcome: "changes_left",
				report: "old findings",
			});
			await h.input.emit(h.run.id, "plan_run.review_finished", { outcome: "changes_left" });
		}
		const nextSha = "b".repeat(40);
		const spawned: CoordinatorSpawnInput[] = [];
		let freshRunId = "";
		const input = {
			...h.input,
			getReviewHead: async () => nextSha,
			mergePassedPr: async () => {
				merges++;
				return { kind: "merged" as const };
			},
			spawn: async (arg: CoordinatorSpawnInput) => {
				spawned.push(arg);
				const step = await h.repos.runs.create({
					agentName: "reviewer",
					projectId: h.planRun.projectId,
					prompt: "new review",
					trigger: "plan-run",
					renderedAgentJson: {},
					baseCommit: arg.baseCommit,
				});
				freshRunId = step.id;
				await arg.onRunCreated?.(step.id);
				return { runId: step.id };
			},
		};
		await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
		await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
		expect(merges).toBe(0);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.baseCommit).toBe(nextSha);
		expect(await loadReviewStage(h.repos, "implementer", h.run.id)).toBe("reviewing");
		await h.repos.runs.markRunning(freshRunId);
		await h.repos.runs.finalize(freshRunId, "succeeded");
		await h.repos.events.append({
			runId: freshRunId,
			kind: "state_change",
			stream: "system",
			ts: new Date().toISOString(),
			sandboxEventSeq: 1,
			payload: { type: "result", result: REPORT.replace(SHA, nextSha) },
		});
		await h.repos.events.append({
			runId: freshRunId,
			kind: "quality_gate.completed",
			stream: "system",
			ts: new Date().toISOString(),
			sandboxEventSeq: 2,
			payload: { commit: nextSha, command: "check", exitCode: 0 },
		});
		await h.input.emit(freshRunId, "review_check.evidence" as never, {
			commit: nextSha,
			findings: [],
			results: [],
		});
		await h.repos.runs.attachStats(freshRunId, { costUsd: 0 });
		await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
		await advanceReview(input, h.run, "https://github.com/o/r/pull/1");
		expect(merges).toBe(1);
		expect(await loadReviewStage(h.repos, "implementer", h.run.id)).toBe("ready_to_merge");
	},
);

test("serializes cancellation with a reviewer spawn and never starts the next step", async () => {
	const h = await harness();
	await h.complete("VERDICT: CHANGES\nFix the issue");
	await h.repos.runs.setPrUrl(h.run.id, "https://github.com/o/r/pull/1");
	let notifyStarted: () => void = () => {};
	let resumeSpawn: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		resumeSpawn = resolve;
	});
	let stepId = "";
	let spawns = 0;
	const input = {
		...h.input,
		spawn: async (arg: CoordinatorSpawnInput) => {
			spawns++;
			const step = await h.repos.runs.create({
				agentName: "rework",
				projectId: h.planRun.projectId,
				prompt: "fix",
				trigger: "plan-run",
				renderedAgentJson: {},
			});
			stepId = step.id;
			await arg.onRunCreated?.(step.id);
			notifyStarted();
			await resume;
			return { runId: step.id };
		},
	};
	const advancing = advancePlanRun(input);
	await started;
	const cancelling = cancelPlanRun({
		planRunId: h.planRun.id,
		repos: h.repos,
		runtimeProvider: { kind: "stub" } as unknown as RuntimeProvider,
	});
	resumeSpawn();
	await advancing;
	await cancelling;
	expect((await h.repos.runs.require(stepId)).state).toBe("cancelled");
	await advancePlanRun(input);
	expect(spawns).toBe(1);
});

test("retries cancellation of the linked runtime after a transport failure", async () => {
	const h = await harness();
	await h.repos.runs.attachBurrow(h.reviewer.id, {
		sandboxId: "sandbox-review",
		sandboxRunId: "runtime-review",
	});
	await h.repos.runs.markRunning(h.reviewer.id);
	let attempts = 0;
	const runtimeProvider = {
		cancel: async (handle: { runId: string }) => {
			expect(handle.runId).toBe(h.reviewer.id);
			attempts++;
			if (attempts === 1) throw new Error("offline");
		},
		status: async () => ({ phase: "cancelled" }),
	} as unknown as RuntimeProvider;
	const reap = async () => {
		await h.repos.runs.finalize(h.reviewer.id, "cancelled");
		return {} as never;
	};
	const input = { planRunId: h.planRun.id, repos: h.repos, runtimeProvider, reap };
	expect((await cancelPlanRun(input)).cancelledChild).toBeNull();
	expect((await h.repos.runs.require(h.reviewer.id)).state).toBe("running");
	expect((await cancelPlanRun(input)).cancelledChild?.runId).toBe(h.reviewer.id);
	expect(attempts).toBe(2);
	expect(await h.repos.runs.countNonTerminal()).toBe(0);
});

test("bounds failing report delivery and retains its diagnosis in the event log", async () => {
	const h = await harness();
	await h.complete();
	let comments = 0;
	const input = {
		...h.input,
		commentOnPr: async () => {
			comments++;
			throw new Error("offline");
		},
	};
	for (let tick = 0; tick < 6; tick++)
		await advanceReview(input, h.run, "https://github.com/o/r/pull/1").catch(() => {});
	expect(comments).toBe(3);
	const events = await h.repos.events.listByRun(h.run.id);
	expect(events.find((e) => e.kind === "plan_run.review_finished")?.payloadJson).toMatchObject({
		outcome: "broken",
	});
});

test("refuses an agent PASS without an independent runtime witness", async () => {
	const h = await harness();
	await h.complete(REPORT, false);
	let merges = 0;
	await advanceReview(
		{
			...h.input,
			mergePassedPr: async () => {
				merges++;
				return { kind: "merged" as const };
			},
		},
		h.run,
		"https://github.com/o/r/pull/1",
	);
	expect(merges).toBe(0);
	expect(await loadReviewStage(h.repos, "implementer", h.run.id)).toBe("needs_attention");
});

test("accepts a pending reviewer gate only after an independent successful execution", async () => {
	const h = await harness();
	await h.complete(REPORT.replace("QUALITY_GATE: PASS", "QUALITY_GATE: NOT_RUN"));
	let merges = 0;
	await advanceReview(
		{
			...h.input,
			mergePassedPr: async () => {
				merges++;
				return { kind: "merged" as const };
			},
		},
		h.run,
		"https://github.com/o/r/pull/1",
	);
	expect(merges).toBe(1);
});
