import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed } from "./sandbox.ts";
import type { SandboxProfile } from "./types.ts";

// Exercise the Linux process transport on either host OS. This shim only
// forwards argv; namespace isolation remains the real bwrap acceptance suite's job.
describe("Linux spawn transport", () => {
	let root: string;
	let shim: string;
	let profile: SandboxProfile;
	let previousLimit: string | undefined;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "linux-spawn-"));
		shim = join(root, "bwrap");
		await writeFile(
			shim,
			'#!/bin/sh\nprintf "%s\\n" "$@" >&2\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
			{ mode: 0o700 },
		);
		const workspace = join(root, "workspace"),
			home = join(root, "home");
		await mkdir(workspace);
		await mkdir(home);
		profile = {
			workspace,
			home,
			readOnlyMounts: [],
			network: "none",
			allowedDomains: [],
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: [],
		};
		previousLimit = process.env.WARREN_SANDBOX_MEMORY_LIMIT_MB;
		process.env.WARREN_SANDBOX_MEMORY_LIMIT_MB = "0";
	});
	afterEach(async () => {
		if (previousLimit === undefined) delete process.env.WARREN_SANDBOX_MEMORY_LIMIT_MB;
		else process.env.WARREN_SANDBOX_MEMORY_LIMIT_MB = previousLimit;
		await rm(root, { recursive: true, force: true });
	});

	test("separates HOME and credentials from workspace and process arguments", async () => {
		const proc = await runSandboxed(
			profile,
			{
				argv: ["/bin/sh", "-c", 'printf "%s|%s|" "$HOME" "$CODEX_HOME"; cat'],
				stdin: "private task",
				env: { CODEX_HOME: "/home/sandbox/.codex", OPENAI_API_KEY: "fake-test-key" },
			},
			{ plat: "linux", bwrapBin: shim },
		);
		const [out, args, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(out).toBe("/home/sandbox|/home/sandbox/.codex|private task");
		expect(args).toContain("/workspace");
		expect(args).not.toContain("fake-test-key");
		expect(args).not.toContain("private task");
	});

	test("supports steering, EOF and cancellation through the shared process contract", async () => {
		const proc = await runSandboxed(
			profile,
			{ argv: ["/bin/cat"], stdin: "first\n", holdStdin: true },
			{ plat: "linux", bwrapBin: shim },
		);
		await proc.writeStdin?.("second\n");
		await proc.closeStdin?.();
		await proc.closeStdin?.();
		expect(await new Response(proc.stdout).text()).toBe("first\nsecond\n");
		expect(await proc.exited).toBe(0);
		const idle = await runSandboxed(
			profile,
			{ argv: ["/bin/sleep", "30"] },
			{ plat: "linux", bwrapBin: shim },
		);
		idle.cancel();
		expect(await idle.exited).not.toBe(0);
		await expect(idle.writeStdin?.("late")).rejects.toThrow("stdin is not writable");
		await idle.closeStdin?.();
	});
});
