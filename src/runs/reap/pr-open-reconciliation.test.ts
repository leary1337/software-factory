import { expect, test } from "bun:test";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { type TryOpenPrInput, tryOpenPr } from "./pr-open.ts";

function request(forge: FakeForge): TryOpenPrInput {
	return {
		forge,
		project: { gitUrl: "fake://owner/project", defaultBranch: "main" },
		branch: "work",
		baseBranch: "main",
		autoOpen: { enabled: true, warrenBaseUrl: null },
		run: {
			id: "run",
			agentName: "implementer",
			prompt: "Work",
			startedAt: null,
			endedAt: null,
			tokensInput: null,
			tokensOutput: null,
			tokensCacheRead: null,
		},
		prContext: { commits: [], diffStat: "", seed: null, finalCommitBody: null },
		previewOptedIn: false,
	};
}
test("holds PR creation while lookup is unavailable", async () => {
	const forge = new FakeForge();
	let creates = 0;
	forge.findPullRequest = async () => ({
		ok: false,
		error: { kind: "network", detail: "connection interrupted" },
	});
	forge.openPullRequest = async () => {
		creates++;
		throw new Error("must not write");
	};
	expect(await tryOpenPr(request(forge))).toMatchObject({ ok: false });
	expect(creates).toBe(0);
});
test("finds an already created PR after its successful response was lost", async () => {
	const forge = new FakeForge();
	const original = forge.openPullRequest.bind(forge);
	let creates = 0;
	forge.openPullRequest = async (ref, draft) => {
		creates++;
		await original(ref, draft);
		throw new Error("response lost");
	};
	await expect(tryOpenPr(request(forge))).rejects.toThrow("response lost");
	expect(await tryOpenPr(request(forge))).toMatchObject({ ok: true, pr: { mode: "exists" } });
	expect(creates).toBe(1);
});
