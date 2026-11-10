import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveUntilSignal } from "./shutdown.ts";

test("drains the real server entrypoint on SIGTERM and exits successfully", async () => {
	const root = await mkdtemp(join(tmpdir(), "warren-stop-"));
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = probe.port;
	await probe.stop(true);
	const server = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], {
		env: {
			PATH: process.env.PATH,
			HOME: root,
			WARREN_DATA_DIR: root,
			WARREN_DB_PATH: join(root, "warren.db"),
			WARREN_API_TOKEN: "fixture-token",
			WARREN_BIND_HOST: "127.0.0.1",
			WARREN_BIND_PORT: String(port),
			WARREN_DISABLE_UI: "1",
			WARREN_LOG_LEVEL: "info",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(server.stdout).text();
	const stderr = new Response(server.stderr).text();
	try {
		let ready = false;
		for (let i = 0; i < 300 && server.exitCode === null; i++) {
			ready = await fetch(`http://127.0.0.1:${port}/healthz`)
				.then((r) => r.ok)
				.catch(() => false);
			if (ready) break;
			await Bun.sleep(20);
		}
		expect(ready).toBe(true);
		server.kill("SIGTERM");
		expect(await server.exited).toBe(0);
		expect(`${await stdout}${await stderr}`).toContain("warren server stopping");
	} finally {
		server.kill();
		await server.exited;
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("remembers a signal during boot and drains once before removing signal handlers", async () => {
	const signals = new EventEmitter();
	const boot = Promise.withResolvers<{ stop(): Promise<void> }>();
	const draining = Promise.withResolvers<void>();
	let stops = 0;
	let finished = false;
	const serving = serveUntilSignal(() => boot.promise, signals).then(() => {
		finished = true;
	});
	expect(signals.listenerCount("SIGTERM")).toBe(1);
	signals.emit("SIGTERM");
	boot.resolve({
		stop: async () => {
			stops++;
			await draining.promise;
		},
	});
	await Bun.sleep(0);
	expect(stops).toBe(1);
	expect(finished).toBe(false);
	signals.emit("SIGINT");
	signals.emit("SIGTERM");
	draining.resolve();
	await serving;
	expect(stops).toBe(1);
	expect(finished).toBe(true);
	expect(signals.listenerCount("SIGTERM")).toBe(0);
	expect(signals.listenerCount("SIGINT")).toBe(0);
});

for (const stage of ["boot", "stop"]) {
	test(`removes signal handlers and propagates a ${stage} failure`, async () => {
		const signals = new EventEmitter();
		const failure = new Error(`${stage} failed`);
		const serving = serveUntilSignal(async () => {
			if (stage === "boot") throw failure;
			return {
				stop: async () => {
					throw failure;
				},
			};
		}, signals);
		signals.emit("SIGINT");
		await expect(serving).rejects.toThrow(failure.message);
		expect(signals.listenerCount("SIGINT")).toBe(0);
		expect(signals.listenerCount("SIGTERM")).toBe(0);
	});
}
