import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCheck, AcceptanceSummary } from "../../core/acceptance-evidence.ts";
import type { SandboxProfile, SpawnResult } from "../../sandbox/types.ts";
import { runAcceptanceChecks } from "./acceptance-checks.ts";
import { QualityGateFailure, recordFailedGateReview } from "./quality-gate-failure.ts";
import { LocalRunStore } from "./run-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const commit = "a".repeat(40);
const check: AcceptanceCheck = {
	id: "login",
	command: "browser-test",
	browser: true,
	artifacts: ["report.txt"],
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "acceptance-"));
	roots.push(root);
	const profile: SandboxProfile = {
		workspace: root,
		home: root,
		readOnlyMounts: [],
		network: "none",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};
	const store = new LocalRunStore();
	const record = store.create({
		runId: "acceptance",
		sandboxId: "local-acceptance",
		workspacePath: root,
		homePath: root,
		branch: "work",
	});
	let calls = 0;
	let verified = false;
	const workspace = {
		profile,
		verify: async () => {
			verified = true;
		},
		cleanup: async () => {},
	};
	const spawn = async (): Promise<SpawnResult> => {
		calls += 1;
		await writeFile(join(root, "report.txt"), "Browser assertion passed");
		return {
			pid: 0,
			stdout: new Blob([]).stream(),
			stderr: new Blob([]).stream(),
			exited: Promise.resolve(0),
			cancel: () => {},
			closeStdin: async () => {},
			writeStdin: async () => {},
		};
	};
	const summary = () =>
		record.events.find((event) => event.kind === "acceptance.completed")
			?.payload as AcceptanceSummary;
	return {
		root,
		store,
		record,
		workspace,
		spawn,
		summary,
		calls: () => calls,
		verified: () => verified,
	};
}

describe("runAcceptanceChecks", () => {
	test("refuses rework evidence when combined artifacts exceed the event limit", async () => {
		const h = await fixture();
		const failure = await runAcceptanceChecks(
			h.store,
			h.record,
			{
				command: "gate",
				commit,
				acceptance: {
					checks: [check],
					enforce: true,
					requireBrowser: true,
					criteria: Array.from({ length: 5 }, (_, index) => ({
						criterion: `Browser check ${index}`,
						checkId: "login",
					})),
				},
			},
			h.workspace,
			async () => {
				const proc = await h.spawn();
				await writeFile(join(h.root, "report.txt"), "x".repeat(250000));
				return { ...proc, exited: Promise.resolve(1) };
			},
			Date.now() + 10000,
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(QualityGateFailure);
		expect(h.summary().criteria[0]?.reason).toContain("event limit");
	});
	test("preserves clean CHANGES after an actual acceptance failure and retains the full-gate PASS", async () => {
		const h = await fixture();
		const failure = await runAcceptanceChecks(
			h.store,
			h.record,
			{
				command: "gate",
				commit,
				acceptance: {
					checks: [check],
					enforce: true,
					requireBrowser: true,
					criteria: [{ criterion: "Sign in", checkId: "login" }],
				},
			},
			h.workspace,
			async () => ({ ...(await h.spawn()), exited: Promise.resolve(1) }),
			Date.now() + 10000,
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(QualityGateFailure);
		recordFailedGateReview(h.store, h.record, failure, 0, undefined, [
			{
				kind: "state_change",
				stream: "system",
				payload: {
					type: "result",
					result: `VERDICT: CHANGES\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: NOT_RUN\nLogin fails.`,
				},
			},
		]);
		expect(h.record.events.at(-1)).toMatchObject({
			kind: "review.check_failed",
			payload: {
				qualityGate: "PASS",
				report: `VERDICT: CHANGES\nREVIEWED_COMMIT: ${commit}\nQUALITY_GATE: PASS\nLogin fails.`,
			},
		});
	});
	test("executes an approved browser check once for two criteria and persists artifact bytes with SHA", async () => {
		const h = await fixture();
		await runAcceptanceChecks(
			h.store,
			h.record,
			{
				command: "gate",
				commit,
				acceptance: {
					checks: [check],
					enforce: true,
					requireBrowser: true,
					criteria: [
						{ criterion: "Sign in", checkId: "login" },
						{ criterion: "Redirect home", checkId: "login" },
					],
				},
			},
			h.workspace,
			h.spawn,
			Date.now() + 10000,
		);
		expect(h.calls()).toBe(1);
		expect(h.verified()).toBe(true);
		expect(h.summary().verified).toBe(true);
		expect(h.summary().criteria[0]).toMatchObject({
			commit,
			result: "PASS",
			browser: true,
			exitCode: 0,
			artifacts: [{ text: "Browser assertion passed", bytes: 24 }],
		});
		expect(h.summary().criteria[0]?.artifacts[0]?.sha256).toHaveLength(64);
		await rm(h.root, { recursive: true });
		expect(h.summary().criteria[0]?.artifacts[0]?.text).toBe("Browser assertion passed");
	});
	test("keeps unmapped criteria unverified and fails only when enforcement is enabled", async () => {
		const h = await fixture();
		const acceptance = {
			checks: [],
			enforce: false,
			requireBrowser: false,
			criteria: [{ criterion: "Works", checkId: null }],
		};
		await runAcceptanceChecks(
			h.store,
			h.record,
			{ command: "gate", commit, acceptance },
			h.workspace,
			h.spawn,
			Date.now() + 10000,
		);
		expect(h.calls()).toBe(0);
		expect(h.summary().criteria[0]?.result).toBe("NOT_RUN");
		await expect(
			runAcceptanceChecks(
				h.store,
				h.record,
				{ command: "gate", commit, acceptance: { ...acceptance, enforce: true } },
				h.workspace,
				h.spawn,
				Date.now() + 10000,
			),
		).rejects.toThrow("not verified");
	});
	test("requires actual browser evidence even when no criterion names a browser check", async () => {
		const h = await fixture();
		await expect(
			runAcceptanceChecks(
				h.store,
				h.record,
				{
					command: "gate",
					commit,
					acceptance: { checks: [], enforce: false, requireBrowser: true, criteria: [] },
				},
				h.workspace,
				h.spawn,
				Date.now() + 10000,
			),
		).rejects.toThrow("not verified");
		expect(h.summary().criteria[0]?.result).toBe("NOT_RUN");
	});
	for (const defect of [
		"stale",
		"symlink",
		"too-large",
		"source-mutated",
		"timeout",
		"nonzero",
	] as const) {
		test(`refuses ${defect} evidence`, async () => {
			const h = await fixture();
			if (defect === "stale") await writeFile(join(h.root, "report.txt"), "old");
			const spawn = async () => {
				const proc = await h.spawn();
				if (defect === "symlink") {
					await rm(join(h.root, "report.txt"));
					await symlink("/etc/hosts", join(h.root, "report.txt"));
				}
				if (defect === "too-large") await writeFile(join(h.root, "report.txt"), "x".repeat(262145));
				return { ...proc, exited: Promise.resolve(defect === "nonzero" ? 1 : 0) };
			};
			if (defect === "source-mutated")
				h.workspace.verify = async () => {
					throw new Error("changed source");
				};
			const failure = await runAcceptanceChecks(
				h.store,
				h.record,
				{
					command: "gate",
					commit,
					acceptance: {
						checks: [check],
						enforce: true,
						requireBrowser: false,
						criteria: [{ criterion: "Login", checkId: check.id }],
					},
				},
				h.workspace,
				spawn,
				Date.now() + (defect === "timeout" ? -1 : 10000),
			).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(failure instanceof QualityGateFailure).toBe(defect === "nonzero");
			expect(h.summary().criteria[0]?.result).toBe("FAIL");
		});
	}
});
