import { expect, test } from "bun:test";
import { openDatabase } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { RunEventBroker } from "../events.ts";
import { bridgeRunStream } from "./bridge.ts";
import { makeProvider, seedBridgeRun } from "./test-helpers.ts";

test("resumes from the runtime cursor across intervening plan events without losing the result", async () => {
	const db = await openDatabase({ path: ":memory:" });
	try {
		const repos = createRepos(db);
		const { runId, sandboxRunId } = await seedBridgeRun(repos);
		const cursors: number[] = [];
		const provider: RuntimeProvider = {
			...makeProvider(),
			status: async () => ({
				exists: true,
				phase: "running",
				exitCode: null,
				lastEventSeq: 2,
				lastEventTs: null,
			}),
			async *streamEvents(_handle, opts) {
				const since = opts?.sinceSeq ?? 0;
				cursors.push(since);
				const last = cursors.length === 1 ? 1 : 2;
				for (let seq = since + 1; seq <= last; seq++)
					yield {
						seq,
						ts: new Date().toISOString(),
						origin: "warren",
						kind: seq === 1 ? "text" : "state_change",
						stream: "system",
						payload:
							seq === 1 ? { text: "Working" } : { type: "result", result: "Done", is_error: false },
					};
			},
		};
		const input = {
			repos,
			runId,
			sandboxRunId,
			sandboxId: "fixture",
			broker: new RunEventBroker(),
			runtimeProvider: provider,
		};
		await repos.events.append({
			runId,
			sandboxEventSeq: 100,
			ts: new Date().toISOString(),
			kind: "plan_run.dispatched",
			payload: {},
		});
		expect((await bridgeRunStream(input)).written).toBe(1);
		await repos.events.append({
			runId,
			sandboxEventSeq: 200,
			ts: new Date().toISOString(),
			kind: "cancel.requested",
			payload: {},
		});
		expect((await bridgeRunStream(input)).terminalDetected).toEqual({ outcome: "succeeded" });
		expect(cursors).toEqual([0, 1]);
		const events = await repos.events.listByRun(runId);
		expect(events.map((e) => e.sandboxEventSeq)).toEqual([100, 101, 200, 201]);
		expect(events.map((e) => e.runtimeEventSeq)).toEqual([null, 1, null, 2]);
		expect(await repos.events.maxRuntimeSeqForRun(runId)).toBe(2);
	} finally {
		await db.close();
	}
});
