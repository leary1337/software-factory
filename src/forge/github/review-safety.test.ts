import { expect, test } from "bun:test";
import { GitHubForge } from "./provider.ts";
import { jsonResponse, recordingFetch } from "./test-helpers.ts";

const REF = { forge: "github", key: "github.com/octo/widget" } as const;
const PR = {
	forge: "github",
	key: "github.com/octo/widget#1",
	number: 1,
	webUrl: "https://github.com/octo/widget/pull/1",
} as const;

test("sends the reviewed SHA as GitHub's atomic merge precondition", async () => {
	const rec = recordingFetch([jsonResponse(409, { message: "Head changed" })]);
	const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
	const sha = "a".repeat(40);
	expect((await forge.mergePullRequest(REF, PR, { expectedHead: sha, method: "squash" })).ok).toBe(
		false,
	);
	expect(JSON.parse(rec.calls[0]?.body ?? "{}")).toEqual({ sha, merge_method: "squash" });
});

test("recovers a lost comment acknowledgement without posting twice", async () => {
	const rec = recordingFetch([
		jsonResponse(200, []),
		() => {
			throw new Error("response lost after POST");
		},
		jsonResponse(200, [{ body: "report\n\n<!-- review-key -->" }]),
	]);
	const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
	expect((await forge.commentOnPullRequest(REF, PR, "report", "review-key")).ok).toBe(false);
	expect((await forge.commentOnPullRequest(REF, PR, "report", "review-key")).ok).toBe(true);
	expect(rec.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

test("does not publish blindly when comment history cannot be read", async () => {
	const rec = recordingFetch([jsonResponse(403, { message: "Forbidden" })]);
	const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
	expect((await forge.commentOnPullRequest(REF, PR, "report", "review-key")).ok).toBe(false);
	expect(rec.calls.map((call) => call.method)).toEqual(["GET"]);
});

test("requires affirmative merge confirmation even on HTTP success", async () => {
	for (const body of [{ merged: false }, {}, { merged: true }]) {
		const rec = recordingFetch([jsonResponse(200, body)]);
		const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
		expect(
			(await forge.mergePullRequest(REF, PR, { expectedHead: "a".repeat(40), method: "squash" }))
				.ok,
		).toBe(body.merged === true);
	}
});

test("finds a report on later comment pages and refuses malformed history", async () => {
	const rec = recordingFetch([
		jsonResponse(
			200,
			Array.from({ length: 100 }, () => ({ body: "another comment" })),
		),
		jsonResponse(200, [{ body: "report <!-- review-key -->" }]),
		jsonResponse(200, { unexpected: true }),
	]);
	const forge = new GitHubForge({ token: "test", fetch: rec.fetch });
	expect((await forge.commentOnPullRequest(REF, PR, "report", "review-key")).ok).toBe(true);
	expect(rec.calls[1]?.url).toContain("page=2");
	expect((await forge.commentOnPullRequest(REF, PR, "report", "review-key")).ok).toBe(false);
	expect(rec.calls.every((call) => call.method === "GET")).toBe(true);
});
