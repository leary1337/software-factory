import { expect, test } from "bun:test";
import { GitHubForge } from "./provider.ts";
import { jsonResponse, recordingFetch } from "./test-helpers.ts";

const SHA = "a".repeat(40);
const REF = { forge: "github", key: "github.com/o/r" };
const run = (id = 1) => ({
	id,
	name: "test",
	head_sha: SHA,
	status: "completed",
	conclusion: "success",
});
const statuses = { sha: SHA, total_count: 0, statuses: [] };
async function read(responses: Response[]) {
	const rec = recordingFetch(responses);
	return {
		result: await new GitHubForge({ token: "test", fetch: rec.fetch }).readMergeChecks(REF, SHA),
		calls: rec.calls,
	};
}
test("reads every check page and includes failing legacy statuses", async () => {
	const { result, calls } = await read([
		jsonResponse(200, {
			total_count: 101,
			check_runs: Array.from({ length: 100 }, (_, i) => run(i)),
		}),
		jsonResponse(200, { total_count: 101, check_runs: [run(101)] }),
		jsonResponse(200, {
			sha: SHA,
			total_count: 1,
			statuses: [{ context: "security", state: "failure" }],
		}),
	]);
	expect(result).toMatchObject({ ok: true, value: { conclusion: "failing" } });
	expect(calls[1]?.url).toContain("page=2");
});
test("requires valid complete responses for the exact commit", async () => {
	for (const body of [
		{},
		{ total_count: 1, check_runs: [] },
		{ total_count: 1, check_runs: [{ ...run(), head_sha: "b".repeat(40) }] },
		{ total_count: 1, check_runs: [{}] },
	]) {
		expect((await read([jsonResponse(200, body)])).result.ok).toBe(false);
	}
	expect(
		(
			await read([
				jsonResponse(200, { total_count: 1, check_runs: [run()] }),
				jsonResponse(403, { message: "denied" }),
			])
		).result.ok,
	).toBe(false);
});
test("distinguishes missing, running, failed and passed CI", async () => {
	for (const [rows, conclusion] of [
		[[], "unknown"],
		[[{ ...run(), status: "in_progress", conclusion: null }], "pending"],
		[[{ ...run(), conclusion: "cancelled" }], "failing"],
		[[run()], "passing"],
		[[{ ...run(), conclusion: null }], "failing"],
	] as const) {
		expect(
			(
				await read([
					jsonResponse(200, { total_count: rows.length, check_runs: rows }),
					jsonResponse(200, statuses),
				])
			).result,
		).toMatchObject({ ok: true, value: { conclusion } });
	}
});
