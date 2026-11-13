import { describe, expect, test } from "bun:test";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import { runIndependentQualityGate } from "./quality-gate.ts";
import { LocalRunStore } from "./run-store.ts";

const SHA = "a".repeat(40);
const profile: SandboxProfile = {
	workspace: "/tmp/reviewer",
	home: "/tmp/reviewer-home",
	readOnlyMounts: [],
	network: "none",
	allowedDomains: [],
	envPassthrough: [],
	setEnv: {},
	toolchainPaths: [],
};
function setup(exitCode = 0) {
	const store = new LocalRunStore();
	const record = store.create({
		runId: "gate-test",
		sandboxId: "local-gate",
		workspacePath: profile.workspace,
		homePath: profile.home,
		branch: "test",
	});
	const calls: Array<{ profile: SandboxProfile; command: SpawnCommand }> = [];
	let verified = false;
	let cleaned = false;
	const spawn = async (
		receivedProfile: SandboxProfile,
		command: SpawnCommand,
	): Promise<SpawnResult> => {
		calls.push({ profile: receivedProfile, command });
		return {
			pid: 100,
			stdout: new Blob(["VERDICT: PASS"]).stream(),
			stderr: new Blob([]).stream(),
			exited: Promise.resolve(exitCode),
			cancel: () => {},
			closeStdin: async () => {},
			writeStdin: async () => {},
		};
	};
	const prepareWorkspace = async () => ({
		profile: { ...profile, workspace: "/tmp/fresh", home: "/tmp/fresh-home" },
		verify: async () => {
			verified = true;
		},
		cleanup: async () => {
			cleaned = true;
		},
	});
	return {
		store,
		record,
		calls,
		spawn,
		prepareWorkspace,
		verified: () => verified,
		cleaned: () => cleaned,
	};
}

describe("runIndependentQualityGate", () => {
	test("stops the reviewer before preparing a separate checkout", async () => {
		const h = setup();
		let stopped = false;
		h.record.proc = {
			...(await h.spawn(profile, { argv: [] })),
			cancel: () => {
				stopped = true;
			},
		};
		await runIndependentQualityGate(
			h.store,
			h.record,
			{ command: "check", commit: SHA },
			profile,
			undefined,
			{
				...h,
				prepareWorkspace: async () => {
					expect(stopped).toBe(true);
					return h.prepareWorkspace();
				},
			},
		);
	});
	test("refuses cancellation during source verification and cleans the disposable checkout", async () => {
		const h = setup();
		await expect(
			runIndependentQualityGate(
				h.store,
				h.record,
				{ command: "check", commit: SHA },
				profile,
				undefined,
				{
					...h,
					prepareWorkspace: async () => ({
						...(await h.prepareWorkspace()),
						verify: async () => {
							h.record.cancelRequested = true;
						},
					}),
				},
			),
		).rejects.toThrow("cancelled");
		expect(h.cleaned()).toBe(true);
		expect(h.record.events.some((e) => e.kind === "quality_gate.completed")).toBe(false);
	});
	test("executes in the fresh sandbox and witnesses the process result", async () => {
		const h = setup();
		await runIndependentQualityGate(
			h.store,
			h.record,
			{ command: "./scripts/check.sh", commit: SHA },
			profile,
			{ CODEX_API_KEY: "never-forward" },
			h,
		);
		expect(h.calls[0]?.profile.workspace).toBe("/tmp/fresh");
		expect(h.calls[0]?.command).toEqual({ argv: ["/bin/sh", "-c", "./scripts/check.sh"] });
		expect(h.verified()).toBe(true);
		expect(h.cleaned()).toBe(true);
		expect(h.record.events.at(-1)).toMatchObject({
			kind: "quality_gate.completed",
			payload: { commit: SHA, exitCode: 0 },
		});
	});
	test("refuses failure even when stdout claims PASS", async () => {
		const h = setup(1);
		await expect(
			runIndependentQualityGate(
				h.store,
				h.record,
				{ command: "check", commit: SHA },
				profile,
				undefined,
				h,
			),
		).rejects.toThrow("exit 1");
		expect(h.record.events.at(-1)).toMatchObject({ payload: { exitCode: 1 } });
		expect(h.cleaned()).toBe(true);
	});
	test("refuses invalid pins and cancelled execution before preparation", async () => {
		const h = setup();
		for (const gate of [
			{ command: "", commit: SHA },
			{ command: "check", commit: "branch" },
		])
			await expect(
				runIndependentQualityGate(h.store, h.record, gate, profile, undefined, h),
			).rejects.toThrow("configured qualityGate");
		h.record.cancelRequested = true;
		await expect(
			runIndependentQualityGate(
				h.store,
				h.record,
				{ command: "check", commit: SHA },
				profile,
				undefined,
				h,
			),
		).rejects.toThrow("cancelled");
		expect(h.calls).toHaveLength(0);
	});
	test("cleans up without issuing a witness if reviewed source changed", async () => {
		const h = setup();
		await expect(
			runIndependentQualityGate(
				h.store,
				h.record,
				{ command: "check", commit: SHA },
				profile,
				undefined,
				{
					...h,
					prepareWorkspace: async () => ({
						...(await h.prepareWorkspace()),
						verify: async () => {
							throw new Error("source changed");
						},
					}),
				},
			),
		).rejects.toThrow("source changed");
		expect(h.record.events.some((e) => e.kind === "quality_gate.completed")).toBe(false);
		expect(h.cleaned()).toBe(true);
	});
});
