import { expect, test } from "bun:test";
import { GitHubForge } from "./provider.ts";
import { jsonResponse, recordingFetch } from "./test-helpers.ts";

const REF = { forge: "github", key: "github.com/octo/widget" };
const BASE = "a".repeat(40);
const PROTECTION = {
	required_status_checks: { strict: true, contexts: ["build"] },
	enforce_admins: { enabled: true },
};

test("requires strict checks and prevents administrator bypass on the actual branch", async () => {
	const rec = recordingFetch([
		jsonResponse(200, PROTECTION),
		jsonResponse(200, { commit: { sha: BASE } }),
	]);
	const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
	expect(await forge.readMergeProtection(REF, "release/current")).toEqual({
		ok: true,
		value: { baseCommit: BASE, requiresUpToDate: true },
	});
	expect(rec.calls.map((call) => call.url)).toEqual([
		"https://api.github.com/repos/octo/widget/branches/release%2Fcurrent/protection",
		"https://api.github.com/repos/octo/widget/branches/release%2Fcurrent",
	]);
});

test("refuses loose, empty, bypassable and malformed protection", async () => {
	for (const protection of [
		{},
		{ ...PROTECTION, enforce_admins: { enabled: false } },
		{ ...PROTECTION, required_status_checks: { strict: false, contexts: ["build"] } },
		{ ...PROTECTION, required_status_checks: { strict: true, contexts: [] } },
		{ ...PROTECTION, required_status_checks: { strict: true, contexts: [""] } },
	]) {
		const rec = recordingFetch([
			jsonResponse(200, protection),
			jsonResponse(200, { commit: { sha: BASE } }),
		]);
		const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
		expect(await forge.readMergeProtection(REF, "main")).toEqual({
			ok: true,
			value: { baseCommit: BASE, requiresUpToDate: false },
		});
	}
});

test("does not manufacture protection after a permission error or missing branch SHA", async () => {
	for (const responses of [
		[jsonResponse(403, {})],
		[jsonResponse(404, {})],
		[jsonResponse(200, PROTECTION), jsonResponse(200, { commit: { sha: "main" } })],
	]) {
		const rec = recordingFetch(responses);
		const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
		expect((await forge.readMergeProtection(REF, "main")).ok).toBe(false);
	}
});
