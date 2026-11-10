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
	test("reads each deployment's latest status, preserving inactive as distinct from live success", async () => {
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
				{ sha: "b", createdAt: "t2", state: "inactive" },
			],
		});
	});

	test("requests the selected deployment page with an encoded environment", async () => {
		const { deploys, calls } = harness({ "deployments?": [] });
		await deploys.listDeployments(ref, "production / primary", 20, 2);
		expect(calls[0]?.url).toContain("environment=production%20%2F%20primary&per_page=20&page=2");
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

	test("reads the workflow contract and sends the exact commit as an explicit input", async () => {
		const { deploys, calls } = harness({
			"contents/.github/workflows": {
				encoding: "base64",
				content: Buffer.from("name: Deploy").toString("base64"),
			},
		});
		expect(await deploys.readWorkflow(ref, "deploy.yml", "main")).toEqual({
			ok: true,
			value: "name: Deploy",
		});
		await deploys.dispatch(ref, "deploy.yml", "main", { factory_sha: "a".repeat(40) });
		expect(calls[1]?.body).toBe(
			JSON.stringify({ ref: "main", inputs: { factory_sha: "a".repeat(40) } }),
		);
	});

	test("rejects malformed history and workflow status instead of assuming none are active", async () => {
		const { deploys } = harness({ "deployments?": {}, "actions/workflows": {}, "compare/": {} });
		expect((await deploys.listDeployments(ref, "production", 5)).ok).toBe(false);
		expect((await deploys.listRuns(ref, "deploy.yml", 100)).ok).toBe(false);
		expect((await deploys.compare(ref, "base", "main")).ok).toBe(false);
	});
	test("reads run display titles independently of the workflow definition SHA", async () => {
		const { deploys } = harness({
			"actions/workflows": {
				workflow_runs: [
					{
						id: 1,
						status: "completed",
						conclusion: "success",
						head_sha: "definition",
						display_title: "Factory deploy target",
						created_at: "today",
						html_url: "https://example.test/run",
					},
				],
			},
		});
		const result = await deploys.listRuns(ref, "deploy.yml", 100);
		expect(result.ok && result.value[0]?.displayTitle).toBe("Factory deploy target");
		expect(result.ok && result.value[0]?.sha).toBe("definition");
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
