import { afterEach, describe, expect, test } from "bun:test";
import { requestGitHub } from "./http.ts";

const servers: Array<{ stop(closeActiveConnections?: boolean): void | Promise<void> }> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
});

function serve(handler: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handler });
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

function stalledBody(status: number): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial private response"));
			},
		}),
		{ status },
	);
}

describe("requestGitHub deadlines", () => {
	test("aborts stalled headers without exposing request credentials or URL", async () => {
		const url = serve(() => new Promise(() => {}));
		const result = await requestGitHub({
			url: `${url}/?private=URL-SECRET`,
			token: "TOKEN-SECRET",
			context: "GET /resource",
			requestTimeoutMs: 200,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("network");
			expect(result.error.message).toContain("timed out");
		}
		expect(JSON.stringify(result)).not.toContain("SECRET");
	}, 3_000);

	test("aborts a stalled error body while preserving its HTTP classification", async () => {
		const url = serve(() => stalledBody(503));
		const result = await requestGitHub({
			url,
			token: "tok",
			context: "GET /resource",
			requestTimeoutMs: 200,
			retry: { maxRetries: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("http_error");
			expect(result.error.status).toBe(503);
		}
		expect(JSON.stringify(result)).not.toContain("private response");
	}, 3_000);

	test("keeps the deadline active while the caller consumes a successful response body", async () => {
		const url = serve(() => stalledBody(200));
		const result = await requestGitHub({
			url,
			token: "tok",
			context: "GET /resource",
			requestTimeoutMs: 300,
		});
		expect(result.ok).toBe(true);
		if (result.ok) await expect(result.response.text()).rejects.toThrow();
	}, 3_000);

	test("uses a fresh deadline for each GET retry after the first signal expired", async () => {
		let requests = 0;
		const signals: AbortSignal[] = [];
		const url = serve(() => {
			requests++;
			return requests === 1 ? new Promise(() => {}) : Response.json({ recovered: true });
		});
		const fetchImpl = (async (input, init) => {
			if (!init?.signal) throw new Error("Missing request deadline");
			expect(init.signal.aborted).toBe(false);
			signals.push(init.signal);
			return fetch(input, init);
		}) as typeof fetch;
		const result = await requestGitHub({
			url,
			token: "tok",
			context: "GET /resource",
			fetch: fetchImpl,
			requestTimeoutMs: 200,
			retry: {
				maxRetries: 1,
				sleep: async () => {
					await Bun.sleep(60);
				},
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.response.json()).toEqual({ recovered: true });
		expect(requests).toBe(2);
		expect(signals).toHaveLength(2);
		expect(signals[0]).not.toBe(signals[1]);
		expect(signals[0]?.aborted).toBe(true);
	}, 3_000);

	test.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
		"returns an unknown %s outcome without repeating a received mutation",
		async (method) => {
			const writes: string[] = [];
			const url = serve(async (request) => {
				writes.push(await request.text());
				return new Promise(() => {});
			});
			const result = await requestGitHub({
				url,
				method,
				token: "tok",
				body: { action: "once" },
				context: `${method} /resource`,
				requestTimeoutMs: 200,
				retry: { maxRetries: 9, sleep: async () => {} },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.kind).toBe("network");
			expect(writes).toEqual([JSON.stringify({ action: "once" })]);
		},
		3_000,
	);
});
