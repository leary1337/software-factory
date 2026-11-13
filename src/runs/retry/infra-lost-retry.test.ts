import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { RunRow } from "../../db/schema.ts";
import { shouldRetryChild } from "../../plan-runs/retry.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SpawnRunInput, SpawnRunResult } from "../spawn/types.ts";
import {
	createInfraLostRetryHook,
	decideInfraLostRetry,
	isInfraLostRunFailure,
} from "./infra-lost-retry.ts";

const NOW = new Date("2026-08-16T12:00:00.000Z");

/** Minimal provider stub — the retry hook never drives it (spawn is stubbed). */
const STUB_PROVIDER: RuntimeProvider = {
	capabilities: {
		previewPorts: false,
		networkPolicy: "none",
		longLived: false,
		midRunSteering: false,
		enforcedResourceLimits: false,
		workspaceArchive: false,
		workspaceGc: false,
	},
	kind: "local",
	create: () => Promise.reject(new Error("not used")),
	streamEvents: () => {
		throw new Error("not used");
	},
	status: () => Promise.reject(new Error("not used")),
	sendMessage: () => Promise.reject(new Error("not used")),
	cancel: () => Promise.reject(new Error("not used")),
	workspaceInfo: () => Promise.reject(new Error("not used")),
	finalize: () => Promise.reject(new Error("not used")),
	terminate: () => Promise.reject(new Error("not used")),
};

interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	spawnCalls: SpawnRunInput[];
	bridgeStarts: string[];
	run: (over?: {
		prompt?: string;
		seedId?: string;
		retryOf?: string;
		/** Extra frontmatter frozen onto the run, beside the cap. */
		frontmatter?: Record<string, unknown>;
		failureReason?: "sandbox_run_lost" | "crashed" | "provider_error" | "preempted";
	}) => Promise<RunRow>;
}

async function setup(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const h: Harness = {
		db,
		repos,
		projectId: project.id,
		spawnCalls: [],
		bridgeStarts: [],
		run: async (over = {}) => {
			const run = await repos.runs.create({
				agentName: "claude-code",
				projectId: project.id,
				prompt: over.prompt ?? "fix the thing",
				renderedAgentJson: {
					frontmatter: {
						...(over.frontmatter ?? {}),
					},
					sections: {},
				},
				trigger: "manual",
				...(over.seedId !== undefined ? { seedId: over.seedId } : {}),
				...(over.retryOf !== undefined ? { retryOf: over.retryOf } : {}),
				now: NOW,
			});
			await repos.runs.markRunning(run.id, NOW);
			return repos.runs.finalize(run.id, "failed", NOW, over.failureReason ?? "sandbox_run_lost");
		},
	};
	return h;
}

function hookFor(h: Harness) {
	return createInfraLostRetryHook({
		repos: h.repos,
		runtimeProvider: STUB_PROVIDER,
		bridges: {
			start: (runId) => {
				h.bridgeStarts.push(runId);
			},
		},
		now: () => NOW,
		spawnRunFn: async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			h.spawnCalls.push(input);
			// Persist the retry row the way the real spawnRun would, so the
			// retry_of link and the already_retried budget are real DB state.
			const run = await h.repos.runs.create({
				agentName: input.agentName,
				projectId: input.projectId,
				prompt: input.prompt,
				renderedAgentJson: { frontmatter: {}, sections: {} },
				trigger: input.trigger ?? "manual",
				...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
				now: NOW,
			});
			return {
				run,
				sandbox: { id: "bur_retry", workspacePath: "" },
				sandboxRun: { id: "brun_retry" },
				agent: { name: input.agentName } as SpawnRunResult["agent"],
			};
		},
	});
}

describe("infra-lost run auto-retry (warren-4af7)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("carries the provider and model the failed run resolved (warren-0d80)", async () => {
		const original = await h.run({
			frontmatter: { provider: "openrouter", model: "moonshotai/kimi-k3" },
		});
		await hookFor(h)(original.id);
		expect(h.spawnCalls[0]?.providerOverride).toBe("openrouter");
		expect(h.spawnCalls[0]?.modelOverride).toBe("moonshotai/kimi-k3");
	});

	test("passes no provider or model for a run that declared none (warren-0d80)", async () => {
		const original = await h.run({});
		await hookFor(h)(original.id);
		expect(h.spawnCalls[0]?.providerOverride).toBeUndefined();
		expect(h.spawnCalls[0]?.modelOverride).toBeUndefined();
	});

	test("retry landing infra-lost stays terminal — no third run", async () => {
		const original = await h.run({});
		const retry = await h.run({ retryOf: original.id });

		await hookFor(h)(retry.id);

		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, retry);
		expect(decision.retry).toBe(false);
		expect(decision.skip).toBe("is_retry");
	});

	test("an original that already spawned a retry earns no second one", async () => {
		const original = await h.run({});
		await h.run({ retryOf: original.id });

		await hookFor(h)(original.id);

		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, original);
		expect(decision.skip).toBe("already_retried");
	});

	test("non-infra-lost failure → no retry", async () => {
		const crashed = await h.run({ failureReason: "crashed" });
		await hookFor(h)(crashed.id);
		expect(h.spawnCalls).toHaveLength(0);
		expect(isInfraLostRunFailure("crashed")).toBe(false);
		expect(isInfraLostRunFailure("sandbox_run_lost")).toBe(true);
	});

	// warren-676c: an operator cancel is terminal — never a retry candidate,
	// even when a reconcile path mislabelled it infra-lost.
	test("cancel-requested sandbox_run_lost run → no retry", async () => {
		const cancelled = await h.run({});
		await h.repos.events.append({
			runId: cancelled.id,
			sandboxEventSeq: 1,
			ts: NOW.toISOString(),
			kind: "cancel.requested",
			stream: "system",
			payload: { mode: "forwarded" },
		});

		await hookFor(h)(cancelled.id);

		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, cancelled);
		expect(decision.retry).toBe(false);
		expect(decision.skip).toBe("cancel_requested");
	});

	// warren-ea4b: Spot preemption joins the retryable infra-lost bucket.
	test("preempted run → one retry; a second preemption stays terminal", async () => {
		expect(isInfraLostRunFailure("preempted")).toBe(true);
		const original = await h.run({ failureReason: "preempted" });

		await hookFor(h)(original.id);

		expect(h.spawnCalls).toHaveLength(1);
		expect(h.spawnCalls[0]?.retryOf).toBe(original.id);
		expect(h.spawnCalls[0]?.dispatchOrigin).toBe("retry_infra_lost");

		// The retry itself landing preempted stays terminal — no third run
		// (the retry-of link IS the budget, same as sandbox_run_lost).
		const retry = await h.run({ retryOf: original.id, failureReason: "preempted" });
		await hookFor(h)(retry.id);
		expect(h.spawnCalls).toHaveLength(1);
		const decision = await decideInfraLostRetry(h.repos, retry);
		expect(decision.retry).toBe(false);
		expect(decision.skip).toBe("is_retry");
	});

	for (const step of ["review", "rework"]) {
		test(`keeps lost ${step} under the plan coordinator without an unlinked retry`, async () => {
			const parent = await h.run({ seedId: "warren-a" });
			const original = await h.run({ seedId: "warren-a" });
			await h.repos.events.append({
				runId: parent.id,
				sandboxEventSeq: 1,
				ts: NOW.toISOString(),
				kind: "plan_run.review_step",
				stream: "system",
				payload: { step, stepRunId: original.id },
			});
			await hookFor(h)(original.id);
			expect(h.spawnCalls).toHaveLength(0);
			expect((await decideInfraLostRetry(h.repos, original)).skip).toBe("plan_run_child");
		});
	}

	test("plan-run child infra-lost → run-level hook stands down; coordinator shape covers it", async () => {
		const original = await h.run({ seedId: "warren-a" });
		const { planRun } = await h.repos.planRuns.create({
			planId: "pl-1",
			projectId: h.projectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "warren-a" }],
			now: NOW,
		});
		await h.repos.planRuns.updateChild({
			planRunId: planRun.id,
			seq: 1,
			patch: { runId: original.id, state: "dispatched" },
			now: NOW,
		});

		await hookFor(h)(original.id);

		// No double retry: the coordinator's warren-6de9 shape owns the child.
		expect(h.spawnCalls).toHaveLength(0);
		const decision = await decideInfraLostRetry(h.repos, original);
		expect(decision.skip).toBe("plan_run_child");
		// …and the coordinator shape now recognises the infra-lost cause.
		const child = (await h.repos.planRuns.listChildren(planRun.id))[0];
		expect(child !== undefined && shouldRetryChild(child, "sandbox_run_lost")).toBe(true);
	});
});
