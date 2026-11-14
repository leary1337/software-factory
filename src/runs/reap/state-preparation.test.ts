import { expect, test } from "bun:test";
import { detectSpawnExecFailure, inferFailureReason } from "./state.ts";
import { setup } from "./test-helpers.ts";

test("classifies preparation errors as environment failures even after reviewer output", async () => {
	const ctx = await setup();
	try {
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "preparation.failed",
			stream: "system",
			payload: { stage: "agent", message: "dependency failed" },
		});
		expect(await inferFailureReason(ctx.repos, ctx.runId, "running")).toBe("spawn_failed");
		expect(await detectSpawnExecFailure(ctx.repos, ctx.runId)).toBe(true);
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "review" },
		});
		expect(await inferFailureReason(ctx.repos, ctx.runId, "running")).toBe("spawn_failed");
		expect(await detectSpawnExecFailure(ctx.repos, ctx.runId)).toBe(false);
	} finally {
		await ctx.db.close();
	}
});
