import { beforeEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import {
	claudeResult,
	evt,
	makeProvider,
	piAgentEnd,
	piTurnEnd,
	seedBridgeRun,
	source,
} from "./test-helpers.ts";
import type { BridgeRunStreamResult, StreamEventView } from "./types.ts";

const SBX = "run_zzzzzzzzzzzz";

function turn(seq: number): StreamEventView {
	return piTurnEnd(SBX, seq, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
}

describe("bridgeRunStream — usage accounting across reconnects (warren-1247)", () => {
	let repos: Repos;
	let runId: string;
	let cancels: string[];

	beforeEach(async () => {
		repos = createRepos(await openDatabase({ path: ":memory:" }));
		runId = (await seedBridgeRun(repos)).runId;
		cancels = [];
	});

	function bridge(events: StreamEventView[]): Promise<BridgeRunStreamResult> {
		return bridgeRunStream({
			runId,
			sandboxRunId: SBX,
			repos,
			broker: new RunEventBroker(),
			sandboxId: "bur_aaaaaaaaaaaa",
			runtimeProvider: makeProvider(),
			cancelBurrowRun: async (reason) => {
				cancels.push(reason);
			},
			source: source(events),
		});
	}

	async function budgetEvents(): Promise<number> {
		const rows = await repos.events.listByRun(runId);
		return rows.filter((e) => e.kind === "budget.exceeded").length;
	}

	test("matches an uninterrupted run's totals across several reconnects", async () => {
		await bridge([turn(1)]);
		await bridge([turn(1), turn(2)]);
		await bridge([turn(1), turn(2), evt(SBX, 3), turn(4)]);
		const last = await bridge([turn(4), turn(5), piAgentEnd(SBX, 6)]);
		expect(last.terminalDetected).toEqual({ outcome: "succeeded" });
		const run = await repos.runs.require(runId);
		expect(run.tokensInput).toBe(40);
		expect(run.tokensOutput).toBe(20);
		expect(run.tokensCacheRead).toBe(8);
		expect(run.tokensCacheWrite).toBe(4);
	});

	test("a replayed terminal event persists the seeded totals without double counting", async () => {
		// Prior pass appended the terminal envelope, then died before the

		await bridge([turn(1), turn(2), piAgentEnd(SBX, 3)]);

		const resumed = await bridge([turn(1), turn(2), piAgentEnd(SBX, 3)]);
		expect(resumed.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(resumed.written).toBe(0);
		expect(cancels).toHaveLength(0);
		const run = await repos.runs.require(runId);
		expect(run.tokensInput).toBe(20);
	});

	test("does not double a claude-code result envelope persisted before the reconnect", async () => {
		const result = claudeResult(SBX, 2, { inputTokens: 100, outputTokens: 50 });
		await bridge([evt(SBX, 1), result]);

		// A replay must preserve the cumulative token counts.
		const resumed = await bridge([evt(SBX, 1), result]);
		expect(resumed.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cancels).toHaveLength(0);
		expect(await budgetEvents()).toBe(0);
		const run = await repos.runs.require(runId);
		expect(run.tokensInput).toBe(100);
	});
	test("ignores provider monetary usage while preserving tokens and completion", async () => {
		const result = await bridge([
			evt(SBX, 1, {
				kind: "state_change",
				stream: "system",
				payload: {
					type: "result",
					is_error: false,
					total_cost_usd: 1_000_000,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			}),
		]);
		expect(result.terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cancels).toHaveLength(0);
		expect(await budgetEvents()).toBe(0);
		const run = await repos.runs.require(runId);
		expect(run.tokensInput).toBe(10);
		expect(run).not.toHaveProperty("costUsd");
	});
});
