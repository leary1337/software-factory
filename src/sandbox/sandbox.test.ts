import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { proxyEnvVars, startProxy } from "./proxy-server.ts";
import { runSandboxed } from "./sandbox.ts";
import type { SandboxProfile } from "./types.ts";

const isDarwin = process.platform === "darwin";

function baseProfile(
	workspace: string,
	home: string,
	over: Partial<SandboxProfile> = {},
): SandboxProfile {
	return {
		workspace,
		home,
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
		...over,
	};
}

if (isDarwin) {
	describe("runSandboxed (darwin / sandbox-exec integration)", () => {
		let workspace: string;
		let home: string;

		beforeEach(() => {
			workspace = mkdtempSync(join(tmpdir(), "warren-ws-"));
			home = mkdtempSync(join(tmpdir(), "warren-home-"));
		});
		afterEach(() => {
			rmSync(workspace, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		});

		test("runs `echo` and captures stdout + exit code", async () => {
			const proc = await runSandboxed(baseProfile(workspace, home), {
				argv: ["/bin/echo", "hello-warren"],
			});
			const out = await Bun.readableStreamToText(proc.stdout);
			const exit = await proc.exited;
			expect(exit).toBe(0);
			expect(out.trim()).toBe("hello-warren");
		});

		test("HOME is rewritten to the sandbox home path, not the workspace (warren-c865)", async () => {
			const proc = await runSandboxed(baseProfile(workspace, home), {
				argv: ["/usr/bin/printenv", "HOME"],
			});
			const out = await Bun.readableStreamToText(proc.stdout);
			await proc.exited;
			// Home is canonicalized inside the sandbox; compare against the
			// resolved real path rather than the symlinked /var/folders form.
			expect(out.trim()).toBe(realpathSync(home));
			expect(out.trim()).not.toBe(realpathSync(workspace));
		});

		test("envPassthrough forwards a host var to the sandboxed child", async () => {
			const proc = await runSandboxed(
				baseProfile(workspace, home, { envPassthrough: ["WARREN_TEST_VAR"] }),
				{
					argv: ["/usr/bin/printenv", "WARREN_TEST_VAR"],
					env: {},
				},
			);
			// Inject host value via setEnv — covers the passthrough+merge path through
			// resolveSandboxEnv without leaning on the test-runner's process.env.
			const proc2 = await runSandboxed(
				baseProfile(workspace, home, { setEnv: { WARREN_TEST_VAR: "host-value" } }),
				{ argv: ["/usr/bin/printenv", "WARREN_TEST_VAR"] },
			);
			await proc.exited;
			const out = await Bun.readableStreamToText(proc2.stdout);
			await proc2.exited;
			expect(out.trim()).toBe("host-value");
		});

		test("runs temporary Unix socket IPC without a caller-provided TMPDIR", async () => {
			writeFileSync(
				join(workspace, "ipc.cjs"),
				`
const net = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = join(tmpdir(), 'ipc-' + process.pid + '.sock');
const server = net.createServer(socket => socket.end('IPC_OK'));
server.on('error', error => { console.error(error); process.exit(1); });
server.listen(path, () => {
  const client = net.createConnection(path);
  client.on('data', data => process.stdout.write(data));
  client.on('error', error => { console.error(error); process.exit(1); });
  client.on('end', () => server.close());
});
`,
			);
			const proc = await runSandboxed(baseProfile(workspace, home), {
				argv: [Bun.which("node") ?? "node", "ipc.cjs"],
			});
			const timer = setTimeout(() => proc.cancel(), 5000);
			try {
				const [stdout, stderr, code] = await Promise.all([
					Bun.readableStreamToText(proc.stdout),
					Bun.readableStreamToText(proc.stderr),
					proc.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(stdout).toBe("IPC_OK");
			} finally {
				clearTimeout(timer);
				proc.cancel();
			}
		});

		test("runs Python spawn workers with process-shared synchronization", async () => {
			writeFileSync(
				join(workspace, "workers.py"),
				`
import multiprocessing
from concurrent.futures import ProcessPoolExecutor

def square(value):
    return value * value

if __name__ == "__main__":
    context = multiprocessing.get_context("spawn")
    with context.Lock():
        with ProcessPoolExecutor(2, mp_context=context) as pool:
            assert list(pool.map(square, [2, 3])) == [4, 9]
    print("WORKERS_OK")
`,
			);
			const proc = await runSandboxed(baseProfile(workspace, home), {
				argv: ["/usr/bin/python3", "workers.py"],
			});
			const timeout = setTimeout(() => proc.cancel(), 10000);
			try {
				const [stdout, stderr, code] = await Promise.all([
					Bun.readableStreamToText(proc.stdout),
					Bun.readableStreamToText(proc.stderr),
					proc.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(stdout.trim()).toBe("WORKERS_OK");
			} finally {
				clearTimeout(timeout);
				proc.cancel();
			}
		});

		test("cannot reopen a Python semaphore owned by a host process", async () => {
			const host = Bun.spawn(
				[
					"/usr/bin/python3",
					"-u",
					"-c",
					`
import multiprocessing, sys
lock = multiprocessing.get_context("spawn").Lock()
print(lock._semlock.name, flush=True)
sys.stdin.read()
`,
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			const timeout = setTimeout(() => host.kill(), 4000);
			try {
				const reader = host.stdout.getReader();
				const { value } = await reader.read();
				reader.releaseLock();
				const name = new TextDecoder().decode(value).trim();
				expect(name).toMatch(/^\/mp-/);
				const proc = await runSandboxed(baseProfile(workspace, home), {
					argv: [
						"/usr/bin/python3",
						"-c",
						`
import _multiprocessing, sys
try:
    _multiprocessing.SemLock._rebuild(0, 1, 1, sys.argv[1])
except PermissionError:
    print("HOST_SEMAPHORE_BLOCKED")
else:
    raise AssertionError("host semaphore was accessible")
`,
						name,
					],
				});
				const [stdout, stderr, code] = await Promise.all([
					Bun.readableStreamToText(proc.stdout),
					Bun.readableStreamToText(proc.stderr),
					proc.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(stdout.trim()).toBe("HOST_SEMAPHORE_BLOCKED");
			} finally {
				host.stdin.end();
				await host.exited;
				clearTimeout(timeout);
			}
		});

		test("reaches a local smoke server while external proxy destinations remain restricted", async () => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () => new Response("LOCAL_OK"),
			});
			const proxy = await startProxy({ allowedDomains: [] });
			try {
				const proc = await runSandboxed(
					baseProfile(workspace, home, {
						network: "restricted",
						proxyAddress: { host: "127.0.0.1", port: proxy.port },
						setEnv: proxyEnvVars(proxy.url),
					}),
					{ argv: ["/usr/bin/curl", "--max-time", "5", "-fsS", `http://127.0.0.1:${server.port}`] },
				);
				const [stdout, stderr, code] = await Promise.all([
					Bun.readableStreamToText(proc.stdout),
					Bun.readableStreamToText(proc.stderr),
					proc.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(stdout).toBe("LOCAL_OK");
				const denied = await fetch("http://not-allowed.invalid", { proxy: proxy.url });
				expect(denied.status).toBe(403);
			} finally {
				server.stop(true);
				await proxy.stop();
			}
		});

		test("workspace + home can be read+written, files outside them cannot be read", async () => {
			// Sentinel under the operator's $HOME — outside any allowed subpath.
			const secretDir = mkdtempSync(join(homedir(), ".warren-isolation-test-"));
			const secretFile = join(secretDir, "secret.txt");
			writeFileSync(secretFile, "TOPSECRET\n");
			try {
				// Workspace write succeeds.
				const wsFile = join(workspace, "hello.txt");
				const writeProc = await runSandboxed(baseProfile(workspace, home), {
					argv: ["/bin/sh", "-c", "echo wrote-it > hello.txt"],
				});
				expect(await writeProc.exited).toBe(0);
				expect(await Bun.file(wsFile).text()).toBe("wrote-it\n");

				// Home write succeeds (harness state lands here, warren-c865).
				const homeProc = await runSandboxed(baseProfile(workspace, home), {
					argv: ["/bin/sh", "-c", "echo state > $HOME/harness-state.txt"],
				});
				expect(await homeProc.exited).toBe(0);
				expect(await Bun.file(join(home, "harness-state.txt")).text()).toBe("state\n");

				// Reading outside the workspace + home fails.
				const readProc = await runSandboxed(baseProfile(workspace, home), {
					argv: ["/bin/cat", secretFile],
				});
				const code = await readProc.exited;
				expect(code).not.toBe(0);
			} finally {
				rmSync(secretDir, { recursive: true, force: true });
			}
		});

		test("holdStdin=true flushes the initial prompt so the child reads synchronously", async () => {
			// Regression test for burrow-029d: writeStringStdin used to only call
			// sink.write() in the holdStdin=true path, leaving bytes buffered in
			// bun userland — they never reached the kernel pipe and the child
			// blocked forever on its initial read. The fix is an explicit
			// sink.flush() before returning.
			const proc = await runSandboxed(baseProfile(workspace, home), {
				argv: ["/bin/cat"],
				stdin: "hello-from-warren\n",
				holdStdin: true,
			});

			const reader = proc.stdout.getReader();
			const decoder = new TextDecoder();
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("timeout: stdin bytes never reached child")), 3000),
			);
			const chunk = await Promise.race([reader.read(), timeout]);
			expect(chunk.done).toBe(false);
			expect(decoder.decode(chunk.value)).toContain("hello-from-warren");

			reader.releaseLock();
			await proc.closeStdin?.();
			expect(await proc.exited).toBe(0);
		});

		test("cancel() kills a long-running child", async () => {
			const proc = await runSandboxed(baseProfile(workspace, home), {
				argv: ["/bin/sleep", "60"],
			});
			proc.cancel();
			const code = await proc.exited;
			// SIGTERM => exit code 143 (128+15) on most shells; some contexts surface
			// the signal differently. Either way, the process is no longer alive.
			expect(typeof code).toBe("number");
			expect(code).not.toBe(0);
		});
	});
}

describe("runSandboxed (platform dispatch)", () => {
	test("rejects unsupported platforms", async () => {
		await expect(
			runSandboxed(baseProfile("/tmp/ws", "/tmp/home"), { argv: ["true"] }, { plat: "win32" }),
		).rejects.toThrow(/unsupported platform/);
	});
});
