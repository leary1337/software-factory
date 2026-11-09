import { describe, expect, test } from "bun:test";
import type { RepoRef } from "../contract.ts";
import { GitHubDeploys } from "./deploys.ts";

const ref = { forge: "github", key: "o/r" } as RepoRef;

function harness(routes: Record<string, unknown>) {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	const fetchStub = (async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method ?? "GET",
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		const key = Object.keys(routes).find((k) => url.includes(k));
		if (key === undefined) return new Response(null, { status: 204 });
		return new Response(JSON.stringify(routes[key]), { status: 200 });
	}) as unknown as typeof fetch;
	const deploys = new GitHubDeploys(
		async () => ({ ok: true, value: { secret: "t" } }),
		() => "o/r",
		fetchStub,
	);
	return { deploys, calls };
}

describe("GitHubDeploys", () => {
	test("reads each deployment's latest status, counting inactive as a past success", async () => {
		const { deploys } = harness({
			"deployments/1/statuses": [{ state: "failure" }],
			"deployments/2/statuses": [{ state: "inactive" }],
			"deployments?": [
				{ id: 1, sha: "a", created_at: "t1" },
				{ id: 2, sha: "b", created_at: "t2" },
			],
		});
		const result = await deploys.listDeployments(ref, "production", 5);
		expect(result).toEqual({
			ok: true,
			value: [
				{ sha: "a", createdAt: "t1", state: "failure" },
				{ sha: "b", createdAt: "t2", state: "success" },
			],
		});
	});

	test("lists pending commits newest first, by their title line", async () => {
		const { deploys } = harness({
			compare: {
				ahead_by: 2,
				commits: [
					{ sha: "old", commit: { message: "First\n\nbody" } },
					{ sha: "new", commit: { message: "Second" } },
				],
			},
		});
		expect(await deploys.compare(ref, "base", "master")).toEqual({
			ok: true,
			value: {
				aheadBy: 2,
				commits: [
					{ sha: "new", title: "Second" },
					{ sha: "old", title: "First" },
				],
			},
		});
	});

	test("starts the workflow on the requested branch", async () => {
		const { deploys, calls } = harness({});
		expect(await deploys.dispatch(ref, "deploy.yml", "master")).toEqual({
			ok: true,
			value: undefined,
		});
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toContain("/repos/o/r/actions/workflows/deploy.yml/dispatches");
		expect(calls[0]?.body).toBe('{"ref":"master"}');
	});
});
