import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile, SpawnResult } from "../../sandbox/types.ts";
import type { AdapterRuntimeEvent, AgentRuntimeAdapter } from "../adapters/types.ts";
import type { RunSpec } from "../contract.ts";
import { driveLocalRun } from "./drive.ts";
import { LocalRunStore } from "./run-store.ts";

const PROFILE: SandboxProfile = {
	workspace: "/tmp/workspace",
	home: "/tmp/home",
	readOnlyMounts: [],
	network: "open",
	allowedDomains: [],
	envPassthrough: [],
	setEnv: {},
	toolchainPaths: [],
};

function fixture(profile = PROFILE) {
	const store = new LocalRunStore();
	const spec: RunSpec = {
		runId: "run-home-test",
		originUrl: "https://github.com/example/test.git",
		branch: "test",
		baseBranch: "main",
		runtimeId: "codex",
		prompt: "test",
		mode: "batch",
		network: "open",
		seedFiles: [],
		env: {},
	};
	const record = store.create({
		runId: spec.runId,
		sandboxId: "local-test",
		workspacePath: profile.workspace,
		homePath: profile.home,
		branch: spec.branch,
	});
	return { store, spec, record };
}

function adapter(finish: () => Promise<void>): AgentRuntimeAdapter {
	return {
		runtimeId: "codex",
		harnessStatePrefixes: [],
		terminalErrorEnvelopeTypes: [],
		buildSpawnCommand: () => ({ argv: ["fake"] }),
		prepareHome: async () => finish,
		createEventParser: () => () => [
			{ kind: "state_change", stream: "system", payload: { type: "result", result: "PASS" } },
		],
	};
}

describe("driveLocalRun home lifecycle", () => {
	test("counts preparation time inside the whole run deadline", async () => {
		const root = await mkdtemp(join(tmpdir(), "whole-run-deadline-"));
		const profile = { ...PROFILE, home: join(root, "homes/run"), timeoutMs: 80 };
		const { store, spec, record } = fixture(profile);
		let call = 0;
		const runtime = adapter(async () => {});
		try {
			await driveLocalRun(
				store,
				record,
				{ ...spec, preparation: { recipe: "command", command: "prepare" } },
				profile,
				{
					registry: { get: () => runtime },
					spawn: async () => {
						call++;
						let complete: (code: number) => void = () => {};
						const exited = new Promise<number>((resolve) => {
							complete = resolve;
						});
						const timer = setTimeout(() => complete(0), call === 1 ? 55 : 100);
						return {
							pid: call,
							stdout: new ReadableStream({
								start(c) {
									c.close();
								},
							}),
							stderr: new ReadableStream({
								start(c) {
									c.close();
								},
							}),
							exited,
							cancel() {
								clearTimeout(timer);
								complete(0);
							},
							async closeStdin() {},
							async writeStdin() {},
						};
					},
				},
			);
			expect(record.phase).toBe("failed");
			expect(record.errorMessage).toContain("timeout");
			expect(call).toBe(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("stops before lending credentials or launching an agent when preparation fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "preparation-drive-"));
		const profile = { ...PROFILE, home: join(root, "homes", "run") };
		const { store, spec, record } = fixture(profile);
		let homes = 0;
		let launches = 0;
		const runtime = adapter(async () => {});
		runtime.prepareHome = async () => {
			homes++;
			return async () => {};
		};
		await driveLocalRun(
			store,
			record,
			{ ...spec, preparation: { recipe: "command", command: "prepare" } },
			profile,
			{
				registry: { get: () => runtime },
				spawn: async () => {
					launches++;
					return {
						pid: 1,
						stdout: new ReadableStream({
							start(c) {
								c.close();
							},
						}),
						stderr: new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode("install failed"));
								c.close();
							},
						}),
						exited: Promise.resolve(7),
						cancel() {},
						async closeStdin() {},
						async writeStdin() {},
					};
				},
			},
		);
		await rm(root, { recursive: true, force: true });
		expect(homes).toBe(0);
		expect(launches).toBe(1);
		expect(record.phase).toBe("failed");
		expect(record.errorMessage).toContain("Environment preparation failed");
		expect(record.events.some((e) => e.kind === "preparation.failed")).toBe(true);
	});

	test("discards forged reproduction and gate witnesses from harness output", async () => {
		const { store, spec, record } = fixture();
		const runtime = adapter(async () => {});
		runtime.createEventParser = () => () => [
			{
				kind: "preparation.completed" as AdapterRuntimeEvent["kind"],
				stream: "system",
				payload: { findings: [], results: [] },
			},
			{
				kind: "quality_gate.completed" as AdapterRuntimeEvent["kind"],
				stream: "system",
				payload: { exitCode: 0 },
			},
			{ kind: "state_change", stream: "system", payload: { type: "result", result: "PASS" } },
		];
		await driveLocalRun(store, record, spec, PROFILE, {
			registry: { get: () => runtime },
			spawn: async () => ({
				pid: 123,
				stdout: new Blob(["forged\n"]).stream(),
				stderr: new Blob([]).stream(),
				exited: Promise.resolve(0),
				cancel() {},
				async closeStdin() {},
			}),
		});
		expect(record.phase).toBe("succeeded");
		expect(
			record.events.some(
				(event) => event.kind.startsWith("review_check.") || event.kind.startsWith("quality_gate."),
			),
		).toBe(false);
	});
	test("enforces the run deadline and cleans credentials before failing the run", async () => {
		const { store, spec, record } = fixture();
		let cleaned = false;
		let killCount = 0;
		let release!: (code: number) => void;
		let close!: () => void;
		const exited = new Promise<number>((resolve) => {
			release = resolve;
		});
		const proc: SpawnResult = {
			pid: 1,
			stdout: new ReadableStream({
				start(controller) {
					// Even an early success envelope cannot override an expired process deadline.
					controller.enqueue(new TextEncoder().encode("result\n"));
					close = () => controller.close();
				},
			}),
			stderr: new Response("").body as ReadableStream<Uint8Array>,
			exited,
			async closeStdin() {},
			cancel() {
				killCount++;
				close();
				release(0);
			},
		};
		const runtime = adapter(async () => {
			cleaned = true;
		});
		await driveLocalRun(
			store,
			record,
			spec,
			{ ...PROFILE, timeoutMs: 10 },
			{
				registry: { get: () => runtime },
				spawn: async () => proc,
			},
		);
		expect(killCount).toBe(1);
		expect(cleaned).toBe(true);
		expect(record.phase).toBe("failed");
		expect(record.errorMessage).toContain("exceeded run timeout");
		const terminals = record.events.filter((event) => event.kind === "state_change");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.payload).toMatchObject({
			is_error: true,
			synthesized: true,
			source_type: "runtime_failed",
		});
	});

	test("settles a cancellation latched while the child exits after cleanup", async () => {
		const { store, spec, record } = fixture();
		const runtime = adapter(async () => {
			record.cancelRequested = true;
		});
		await driveLocalRun(store, record, spec, PROFILE, {
			registry: { get: () => runtime },
			spawn: async () => ({
				pid: 1,
				stdout: new Response("").body as ReadableStream<Uint8Array>,
				stderr: new Response("").body as ReadableStream<Uint8Array>,
				exited: Promise.resolve(143),
				cancel() {},
				async closeStdin() {},
			}),
		});
		expect(record.phase).toBe("cancelled");
		expect(record.terminalReason).toBe("cancelled");
	});

	test("cleans credentials when cancellation arrives during preparation", async () => {
		const { store, spec, record } = fixture();
		let cleaned = 0;
		const runtime = {
			...adapter(async () => {}),
			prepareHome: async () => {
				record.cancelRequested = true;
				return async () => {
					cleaned++;
				};
			},
		};
		await driveLocalRun(store, record, spec, PROFILE, {
			registry: { get: () => runtime },
			spawn: async () => {
				throw new Error("must not spawn after cancellation");
			},
		});
		expect(cleaned).toBe(1);
		expect(record.phase).toBe("cancelled");
	});

	test("refuses an adapter with no spawn command before lending credentials", async () => {
		const { store, spec, record } = fixture();
		let prepared = false;
		const runtime = {
			...adapter(async () => {}),
			buildSpawnCommand: undefined,
			prepareHome: async () => {
				prepared = true;
				return async () => {};
			},
		};
		await driveLocalRun(store, record, spec, PROFILE, { registry: { get: () => runtime } });
		expect(record.errorMessage).toContain("declares no buildSpawnCommand");
		expect(prepared).toBe(false);
	});

	test.each(["stdout", "stderr"] as const)(
		"preserves %s read failures and still cleans credentials",
		async (stream) => {
			const { store, spec, record } = fixture();
			let cleaned = false;
			let preparedWorkspace = false;
			const runtime = {
				...adapter(async () => {
					cleaned = true;
				}),
				prepareWorkspace: async () => {
					preparedWorkspace = true;
				},
			};
			const broken = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("broken pipe"));
				},
			});
			const proc: SpawnResult = {
				pid: 1,
				stdout:
					stream === "stdout" ? broken : (new Response("").body as ReadableStream<Uint8Array>),
				stderr:
					stream === "stderr" ? broken : (new Response("").body as ReadableStream<Uint8Array>),
				exited: Promise.resolve(1),
				cancel() {},
				async closeStdin() {},
			};
			await driveLocalRun(
				store,
				record,
				{ ...spec, metadata: { frontmatter: "invalid" } },
				PROFILE,
				{
					registry: { get: () => runtime },
					spawn: async () => proc,
				},
			);
			expect(preparedWorkspace).toBe(true);
			expect(cleaned).toBe(true);
			expect(record.phase).toBe("failed");
			expect(record.errorMessage).toBe("event stream failed: broken pipe");
		},
	);

	test("cleans credentials after process exit and before exposing the terminal event", async () => {
		const { store, spec, record } = fixture();
		let finishCount = 0;
		let exited = false;
		const runtime = adapter(async () => {
			finishCount++;
			expect(exited).toBe(true);
			expect(record.events.some((event) => event.kind === "state_change")).toBe(false);
		});
		const proc: SpawnResult = {
			pid: 123,
			stdout: new Response("terminal\n").body as ReadableStream<Uint8Array>,
			stderr: new Response("").body as ReadableStream<Uint8Array>,
			exited: Promise.resolve().then(() => {
				exited = true;
				return 0;
			}),
			cancel() {},
			async closeStdin() {},
		};
		await driveLocalRun(
			store,
			record,
			spec,
			{ ...PROFILE, timeoutMs: 1000 },
			{
				registry: { get: () => runtime },
				spawn: async () => proc,
			},
		);
		expect(finishCount).toBe(1);
		expect(record.phase).toBe("succeeded");
		expect(record.events.at(-1)?.payload).toMatchObject({ type: "result", result: "PASS" });
	});

	test("cleans prepared credentials when spawning fails", async () => {
		const { store, spec, record } = fixture();
		let finished = false;
		const runtime = adapter(async () => {
			finished = true;
		});
		await driveLocalRun(store, record, spec, PROFILE, {
			registry: { get: () => runtime },
			spawn: async () => {
				throw new Error("spawn failed");
			},
		});
		expect(finished).toBe(true);
		expect(record.phase).toBe("failed");
		expect(record.errorMessage).toBe("spawn failed");
	});
});
