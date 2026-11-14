import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { createGitFixture } from "../../workspace/git/test-fixture.ts";
import { CODEX_RUNTIME_ID } from "../adapters/codex.ts";
import type { AgentRuntimeAdapter } from "../adapters/types.ts";
import type { RunSpec } from "../contract.ts";
import { resolveLocalExecutionMode } from "./execution-mode.ts";
import { resolveCodexExecutable, runHostProcess } from "./process-spawn.ts";
import { LocalProvider } from "./provider.ts";
import { LocalRunStore } from "./run-store.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for process state");
}

async function setup(script: string) {
	const fixture = await createGitFixture({ prefix: "factory-process-", initCommit: "base" });
	const store = new LocalRunStore();
	let launches = 0;
	const adapter: AgentRuntimeAdapter = {
		runtimeId: CODEX_RUNTIME_ID,
		harnessStatePrefixes: [],
		terminalErrorEnvelopeTypes: [],
		buildSpawnCommand: () => {
			launches++;
			return { argv: ["/bin/sh", "-c", script] };
		},
		createEventParser: () => (line) => [
			{ kind: "text", stream: "stdout", payload: { text: line } },
		],
	};
	const provider = new LocalProvider({
		serverEnv: { WARREN_LOCAL_EXECUTION: "process", WARREN_DATA_DIR: join(fixture.root, "data") },
		store,
		drive: { registry: { get: () => adapter } },
	});
	const spec: RunSpec = {
		runId: "process-test",
		originUrl: "https://example.invalid/test.git",
		hostClonePathHint: fixture.path,
		branch: "run-test",
		baseBranch: "main",
		runtimeId: CODEX_RUNTIME_ID,
		prompt: "test",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: {},
	};
	return { fixture, store, provider, spec, launches: () => launches };
}

describe("resolveLocalExecutionMode", () => {
	test("retains sandbox defaults and refuses unsupported rollout targets", () => {
		expect(resolveLocalExecutionMode({}, "linux")).toBe("sandbox");
		expect(resolveLocalExecutionMode({ WARREN_LOCAL_EXECUTION: "process" }, "darwin")).toBe(
			"process",
		);
		expect(() => resolveLocalExecutionMode({ WARREN_LOCAL_EXECUTION: "process" }, "linux")).toThrow(
			"requires macOS",
		);
		expect(() => resolveLocalExecutionMode({ WARREN_LOCAL_EXECUTION: "typo" })).toThrow("Unknown");
		expect(() => resolveCodexExecutable({ WARREN_CODEX_BIN: "./codex" })).toThrow("absolute path");
	});
});

describe.skipIf(process.platform !== "darwin")("local process mode", () => {
	test("runs through the provider with private paths and ordinary execution history", async () => {
		const h = await setup('printf "%s\\n%s\\n" "$PWD" "$HOME"; echo complete');
		try {
			expect(h.provider.capabilities.networkPolicy).toBe("none");
			expect(h.provider.capabilities.enforcedResourceLimits).toBe(false);
			const handle = await h.provider.create(h.spec);
			const record = h.store.getByRunId(h.spec.runId);
			await record?.driveDone;
			expect((await h.provider.status(handle)).phase).toBe("succeeded");
			expect(record?.workspacePath).not.toBe(h.fixture.path);
			expect(record?.workspacePath).not.toBe(record?.homePath);
			expect(record?.profile?.network).toBe("open");
			expect(record?.events.filter((event) => event.kind === "text")).toHaveLength(3);
			expect(h.launches()).toBe(1);
			await h.provider.terminate(handle);
		} finally {
			await h.fixture.cleanup();
		}
	});

	for (const operation of ["cancel", "timeout"] as const) {
		test(`kills descendants and records ${operation} without retrying`, async () => {
			const h = await setup("sleep 30 & echo $! > descendant.pid; wait");
			try {
				const handle = await h.provider.create({ ...h.spec, timeoutMs: 600 });
				const record = h.store.getByRunId(h.spec.runId);
				if (!record) throw new Error("missing run");
				const childFile = join(record.workspacePath, "descendant.pid");
				await waitFor(() => Bun.file(childFile).exists());
				const pid = Number(await readFile(childFile, "utf8"));
				expect(alive(pid)).toBe(true);
				if (operation === "cancel") await h.provider.cancel(handle);
				await record.driveDone;
				await waitFor(async () => !alive(pid));
				expect(record.phase).toBe(operation === "cancel" ? "cancelled" : "failed");
				if (operation === "timeout") expect(record.errorMessage).toContain("run timeout");
				expect(h.launches()).toBe(1);
				await h.provider.terminate(handle);
			} finally {
				await h.fixture.cleanup();
			}
		});
	}

	test("runs the independent gate through the same host execution path", async () => {
		const h = await setup("echo reviewed");
		try {
			const commit = (await h.fixture.git(["rev-parse", "HEAD"])).stdout.trim();
			const handle = await h.provider.create({
				...h.spec,
				qualityGate: { commit, command: 'test "$HOME" != "$PWD" && sleep 0.3 && echo checked' },
			});
			const record = h.store.getByRunId(h.spec.runId);
			if (!record) throw new Error("missing run");
			await waitFor(async () => {
				if (!record.events.some((event) => event.kind === "quality_gate.started")) return false;
				const marker = JSON.parse(await readFile(`${record.homePath}.lifecycle.json`, "utf8"));
				return marker.state === "running";
			});
			await record.driveDone;
			expect(record.phase).toBe("succeeded");
			expect(record?.events.some((event) => event.kind === "quality_gate.completed")).toBe(true);
			await h.provider.terminate(handle);
		} finally {
			await h.fixture.cleanup();
		}
	});

	test("refuses other harnesses and unenforceable network isolation before starting", async () => {
		const h = await setup("exit 0");
		try {
			expect(() => h.provider.create({ ...h.spec, runtimeId: "claude-code" })).toThrow(
				"only Codex",
			);
			expect(() => h.provider.create({ ...h.spec, network: "none" })).toThrow("network=none");
			expect(h.launches()).toBe(0);
		} finally {
			await h.fixture.cleanup();
		}
	});

	test("honors the executable override and stdin without starting a sandbox", async () => {
		const fixture = await createGitFixture({ prefix: "factory-process-bin-" });
		try {
			const home = join(fixture.root, "home");
			await mkdir(home);
			const profile: SandboxProfile = {
				workspace: fixture.path,
				home,
				readOnlyMounts: [],
				network: "open",
				allowedDomains: [],
				envPassthrough: [],
				setEnv: {},
				toolchainPaths: [],
			};
			const child = await runHostProcess(
				profile,
				{ argv: [CODEX_RUNTIME_ID], stdin: "hello" },
				{
					codexBin: "/bin/cat",
				},
			);
			expect(await new Response(child.stdout).text()).toBe("hello");
			expect(await child.exited).toBe(0);
		} finally {
			await fixture.cleanup();
		}
	});
});
