import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_PROVIDER_CAPABILITIES, LocalProvider } from "./provider.ts";
import { LocalRunStore } from "./run-store.ts";

/**
 * The provider is engine-only now (warren-ea0a): building it with no deps
 * yields the in-process engine. The live method paths are covered per-method
 * (`engine.test.ts`, `finalize.test.ts`, `drive.test.ts`).
 */
describe("LocalProvider", () => {
	test("exposes events, steering, cancellation and teardown through the provider boundary", async () => {
		const data = await mkdtemp(join(tmpdir(), "provider-lifecycle-"));
		try {
			const store = new LocalRunStore();
			const record = store.create({
				runId: "run_provider",
				sandboxId: "local-provider",
				workspacePath: join(data, "workspace"),
				homePath: join(data, "home"),
				branch: "test",
			});
			const provider = new LocalProvider({ serverEnv: { WARREN_DATA_DIR: data }, store });
			const handle = {
				runId: record.runId,
				providerRunId: record.runId,
				sandboxId: record.sandboxId,
			};
			store.markRunning(record);
			store.appendEvent(record, { kind: "text", stream: "stdout", payload: { text: "working" } });
			expect((await provider.status(handle)).phase).toBe("running");
			expect((await provider.workspaceInfo(handle)).branch).toBe("test");
			const message = await provider.sendMessage(handle, {
				body: "finish",
				priority: "normal",
				fromActor: "operator",
			});
			expect(message.body).toBe("finish");
			await provider.cancel(handle);
			expect((await provider.status(handle)).phase).toBe("cancelled");
			const events = [];
			for await (const event of provider.streamEvents(handle)) events.push(event);
			expect(events[0]?.payload).toEqual({ text: "working" });
			expect((await provider.terminate(handle)).deletedRuns).toBe(1);
			expect((await provider.status(handle)).exists).toBe(false);
		} finally {
			await rm(data, { recursive: true, force: true });
		}
	});

	test("advertises the full local capability set", () => {
		const provider = new LocalProvider();
		expect(provider.capabilities).toBe(LOCAL_PROVIDER_CAPABILITIES);
		expect(provider.capabilities).toEqual({
			previewPorts: true,
			networkPolicy: "domain-allowlist",
			longLived: true,
			midRunSteering: true,
			enforcedResourceLimits: true,
			workspaceArchive: true,
			workspaceGc: true,
		});
	});

	test("reports kind local (warren-e1f1)", () => {
		expect(new LocalProvider().kind).toBe("local");
	});

	test("capabilities are frozen", () => {
		expect(Object.isFrozen(LOCAL_PROVIDER_CAPABILITIES)).toBe(true);
	});
});
