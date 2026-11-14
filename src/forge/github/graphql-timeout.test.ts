import { afterEach, describe, expect, test } from "bun:test";
import { GITHUB_GRAPHQL_URL, requestGitHubGraphQL } from "./graphql.ts";

const servers: Array<{ stop(closeActiveConnections?: boolean): void | Promise<void> }> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
});

describe("GraphQL mutation deadline", () => {
	for (const phase of ["headers", "body"] as const) {
		test(`stops a received mutation with stalled ${phase} without sending it again`, async () => {
			const received: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				async fetch(request) {
					received.push(await request.text());
					if (phase === "headers") return new Promise<Response>(() => {});
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('{"data":'));
							},
						}),
						{ status: 200 },
					);
				},
			});
			servers.push(server);
			const query =
				"mutation EnableAutoMerge { enablePullRequestAutoMerge { pullRequest { id } } }";
			const redirect: typeof fetch = Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					expect(String(input)).toBe(GITHUB_GRAPHQL_URL);
					return fetch(`http://127.0.0.1:${server.port}`, init);
				},
				{ preconnect: fetch.preconnect },
			);
			const result = await requestGitHubGraphQL({
				query,
				token: "PRIVATE-TOKEN",
				context: "mutation enable auto merge",
				fetch: redirect,
				requestTimeoutMs: 300,
				retry: { maxRetries: 9, sleep: async () => {} },
			});
			expect(received).toEqual([JSON.stringify({ query })]);
			expect(result.ok).toBe(false);
			if (!result.ok && result.error.kind === "http") {
				expect(result.error.error.kind).toBe(phase === "headers" ? "network" : "http_error");
			} else throw new Error("Expected bounded transport failure");
			expect(JSON.stringify(result)).not.toContain("PRIVATE-TOKEN");
		}, 3000);
	}
});
