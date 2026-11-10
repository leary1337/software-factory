import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { defaultHttp, defaultSpawn } from "./agent-io.ts";

describe("agent process transport", () => {
	test("delivers a batch prompt through stdin and closes it for an EOF-reading harness", async () => {
		const proc = await defaultSpawn(
			{
				argv: [
					process.execPath,
					"-e",
					'const prompt = await Bun.stdin.text(); console.log(JSON.stringify({prompt, key: process.env.OPENAI_API_KEY})); console.error("diagnostic");',
				],
				stdin: "private prompt\nsecond line",
				env: { OPENAI_API_KEY: "" },
			},
			{ cwd: tmpdir() },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ prompt: "private prompt\nsecond line", key: "" });
		expect(stderr).toBe("diagnostic\n");
	});

	test("flushes held input and steering before closing stdin exactly once", async () => {
		const proc = await defaultSpawn(
			{
				argv: [process.execPath, "-e", "console.log(await Bun.stdin.text())"],
				stdin: "initial\n",
				holdStdin: true,
			},
			{ cwd: tmpdir() },
		);
		await proc.writeStdin?.("steer\n");
		await proc.closeStdin?.();
		await proc.closeStdin?.();
		expect(await new Response(proc.stdout).text()).toBe("initial\nsteer\n\n");
		expect(await proc.exited).toBe(0);
		await expect(proc.writeStdin?.("late")).rejects.toThrow("stdin already closed");
	});

	test("closes absent batch input and can stop an idle child", async () => {
		const batch = await defaultSpawn(
			{
				argv: [process.execPath, "-e", "console.log((await Bun.stdin.text()).length)"],
			},
			{ cwd: tmpdir() },
		);
		expect(await new Response(batch.stdout).text()).toBe("0\n");
		expect(await batch.exited).toBe(0);
		const idle = await defaultSpawn(
			{
				argv: [process.execPath, "-e", 'console.log("ready"); setInterval(() => {}, 1000)'],
				holdStdin: true,
			},
			{ cwd: tmpdir() },
		);
		const reader = idle.stdout.getReader();
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
			expect(idle.pid).toBeGreaterThan(0);
		} finally {
			reader.releaseLock();
			idle.kill?.();
		}
		expect(await idle.exited).not.toBe(0);
	});
});

describe("agent inbox HTTP transport", () => {
	test("passes the scoped credential and reads only successful JSON responses", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.headers.get("authorization") !== "Bearer fake-inbox-token") {
					return new Response("denied", { status: 401 });
				}
				return Response.json({ messages: [{ body: "steer" }] });
			},
		});
		try {
			expect(await defaultHttp.get(String(server.url), "fake-inbox-token")).toEqual({
				status: 200,
				body: { messages: [{ body: "steer" }] },
			});
			expect(await defaultHttp.get(String(server.url), "wrong")).toEqual({
				status: 401,
				body: null,
			});
		} finally {
			await server.stop(true);
		}
	});
});
