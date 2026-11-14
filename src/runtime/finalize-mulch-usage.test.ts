/**
 * Both finalize paths surface mulch usage attribution: a workspace
 * `.mulch/state/usage.jsonl` becomes one `mulch.usage` event in
 * `FinalizeResult.events` (re-emitted onto the run by reap), and its absence
 * adds nothing (fail-open).
 */

import { describe, expect, test } from "bun:test";
import { fakeExec, fakeFs } from "../runs/reap/test-helpers.ts";
import type { FinalizeIntent } from "./contract.ts";
import { finalizeLocalWorkspace } from "./local/finalize.ts";
import { MULCH_USAGE_EVENT } from "./mulch-usage.ts";

const WS = "/data/sandbox/ws";
const USAGE =
	'{"ts":"2026-09-01T00:00:00.000Z","session":"s1","tool":"Read","files":["a.ts"],"ids":["mx-a","mx-b"]}\n' +
	'{"ts":"2026-09-01T00:00:05.000Z","session":"s1","tool":"Edit","files":["a.ts"],"ids":["mx-a"]}\n';

const LOCAL_INTENT: FinalizeIntent = {
	branch: "warren/run-1",
	push: false,
	artifacts: [],
};

function usageEvents(events: ReadonlyArray<{ kind: string; payload: unknown }>) {
	return events.filter((e) => e.kind === MULCH_USAGE_EVENT);
}

describe("LocalProvider finalize — mulch usage", () => {
	test("emits one mulch.usage event summarizing the workspace log", async () => {
		const fs = fakeFs({ [`${WS}/.mulch/state/usage.jsonl`]: USAGE });
		const r = await finalizeLocalWorkspace(
			{ workspacePath: WS, readTracker: async () => null },
			LOCAL_INTENT,
			{ fs: fs.fs, exec: fakeExec().exec },
		);
		const [ev] = usageEvents(r.events);
		expect(ev?.payload).toMatchObject({
			injections: 2,
			uniqueRecords: 2,
			records: [
				{ id: "mx-a", count: 2 },
				{ id: "mx-b", count: 1 },
			],
		});
	});

	test("an absent log adds no event", async () => {
		const r = await finalizeLocalWorkspace(
			{ workspacePath: WS, readTracker: async () => null },
			LOCAL_INTENT,
			{ fs: fakeFs({}).fs, exec: fakeExec().exec },
		);
		expect(usageEvents(r.events)).toEqual([]);
	});
});
