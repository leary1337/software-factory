import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewFinding } from "../../core/review-findings.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../sandbox/types.ts";
import { parseReviewEvidence, parseReviewManifest, REVIEW_MANIFEST } from "../review-artifacts.ts";
import { collectReviewFindings, runReviewChecks } from "./review-checks.ts";
import { LocalRunStore } from "./run-store.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const SHA = "a".repeat(40);
const finding: ReviewFinding = {
	id: "lost-write",
	title: "Retain acknowledged writes",
	command: 'node "$WARREN_REPRO_DIR/repro.cjs"',
	files: [
		{
			path: "repro.cjs",
			contents: 'require("node:assert/strict").equal(require("../behavior.cjs"), true);',
		},
	],
};
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "review-checks-"));
	roots.push(root);
	const store = new LocalRunStore();
	const record = store.create({
		runId: "r",
		sandboxId: "s",
		workspacePath: root,
		homePath: root,
		branch: "work",
	});
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
	const spawn = async (profile: SandboxProfile, command: SpawnCommand): Promise<SpawnResult> => {
		const proc = Bun.spawn(command.argv, {
			cwd: profile.workspace,
			env: { ...process.env, ...profile.setEnv },
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			pid: proc.pid,
			stdout: proc.stdout,
			stderr: proc.stderr,
			exited: proc.exited,
			cancel: () => {
				proc.kill();
			},
			closeStdin: async () => {},
			writeStdin: async () => {},
		};
	};
	return {
		root,
		store,
		record,
		spawn,
		workspace: { profile, verify: async () => {}, cleanup: async () => {} },
	};
}

describe("review reproductions", () => {
	test("retains exact sources after reviewer cleanup and proves red then green", async () => {
		const h = await setup();
		await writeFile(
			join(h.root, REVIEW_MANIFEST),
			JSON.stringify({ version: 1, findings: [finding] }),
		);
		const artifacts = await collectReviewFindings(h.root, []);
		await rm(join(h.root, REVIEW_MANIFEST));
		await writeFile(join(h.root, "behavior.cjs"), "module.exports = false;");
		await runReviewChecks(
			h.store,
			h.record,
			SHA,
			artifacts,
			h.workspace,
			h.spawn,
			Date.now() + 10_000,
		);
		const red = parseReviewEvidence(h.record.events.at(-1)?.payload);
		expect(red?.results[0]?.exitCode).toBe(1);
		expect(red?.findings).toEqual([finding]);
		await writeFile(join(h.root, "behavior.cjs"), "module.exports = true;");
		await runReviewChecks(
			h.store,
			h.record,
			"b".repeat(40),
			red?.findings ?? [],
			h.workspace,
			h.spawn,
			Date.now() + 10_000,
		);
		expect(parseReviewEvidence(h.record.events.at(-1)?.payload)?.results[0]?.exitCode).toBe(0);
	});
	test("rejects a manifest symlink, duplicate ids and traversal paths", async () => {
		const h = await setup();
		await writeFile(join(h.root, "target"), "{}");
		await symlink(join(h.root, "target"), join(h.root, REVIEW_MANIFEST));
		await expect(collectReviewFindings(h.root, [])).rejects.toThrow();
		const manifest = (value: unknown) => JSON.stringify({ version: 1, findings: value });
		expect(() => parseReviewManifest(manifest([finding]), [finding])).toThrow();
		expect(() =>
			parseReviewManifest(
				manifest([{ ...finding, files: [{ path: "../escape", contents: "x" }] }]),
				[],
			),
		).toThrow();
		expect(() =>
			parseReviewManifest(
				manifest([{ ...finding, files: [...finding.files, ...finding.files] }]),
				[],
			),
		).toThrow();
	});
	test("never witnesses source mutation as a closed finding", async () => {
		const h = await setup();
		await writeFile(join(h.root, "behavior.cjs"), "module.exports = true;");
		await expect(
			runReviewChecks(
				h.store,
				h.record,
				SHA,
				[finding],
				{
					...h.workspace,
					verify: async () => {
						throw new Error("source changed");
					},
				},
				h.spawn,
				Date.now() + 10_000,
			),
		).rejects.toThrow("source changed");
		expect(h.record.events.some((event) => event.kind === "review_check.evidence")).toBe(false);
	});
	test("marks timeouts as unverifiable and never closes the finding", async () => {
		const h = await setup();
		const hanging = {
			...finding,
			files: [{ path: "repro.cjs", contents: "setInterval(() => {}, 1000);" }],
		};
		await runReviewChecks(
			h.store,
			h.record,
			SHA,
			[hanging],
			h.workspace,
			h.spawn,
			Date.now() + 100,
		);
		expect(parseReviewEvidence(h.record.events.at(-1)?.payload)?.results[0]?.error).toContain(
			"timed out",
		);
	});
	test("refuses missing or duplicated machine results", () => {
		expect(parseReviewEvidence({ commit: SHA, findings: [finding], results: [] })).toBeNull();
		expect(
			parseReviewEvidence({
				commit: SHA,
				findings: [finding],
				results: [{ id: "other", exitCode: 0 }],
			}),
		).toBeNull();
	});
	test("keeps captured artifacts independent of later manifest changes", async () => {
		const h = await setup();
		const path = join(h.root, REVIEW_MANIFEST);
		await writeFile(path, JSON.stringify({ version: 1, findings: [finding] }));
		const original = await collectReviewFindings(h.root, []);
		await writeFile(path, JSON.stringify({ version: 1, findings: [] }));
		expect(original).toEqual([finding]);
		expect(await readFile(path, "utf8")).not.toContain("lost-write");
	});
});
