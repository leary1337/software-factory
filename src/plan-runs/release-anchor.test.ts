import { describe, expect, test } from "bun:test";
import type { DeployRun, ForgeDeploys, RepoRef } from "../forge/contract.ts";
import type { DeploymentAttempt } from "./deployment-contract.ts";
import { workflowReleaseAnchor } from "./release-anchor.ts";

const sha = "b".repeat(40);
const ref = { forge: "github", key: "o/r" } as RepoRef;
const failed: DeploymentAttempt = {
	expectedSha: "a".repeat(40),
	shaInput: "factory_sha",
	branch: "main",
	workflow: "deploy.yml",
	environment: "production",
	smokeUrl: "https://app.test/health",
	timeoutMs: 60000,
	smokeTimeoutMs: 5000,
	startedAt: "2026-11-14T12:00:00Z",
	previousRunIds: [7, 6],
	verification: {
		artifactName: "proof",
		versionUrl: "https://app.test/version",
		scenarioUrl: "https://app.test/",
		expectedText: "Works",
	},
};
const baseline: DeployRun = {
	id: 7,
	displayTitle: `Factory deploy ${sha}`,
	status: "completed",
	conclusion: "success",
	sha: "c".repeat(40),
	createdAt: "2026-11-14T11:00:00Z",
	url: "https://forge.test/run/7",
};
const proof = {
	schemaVersion: 1,
	sha,
	workflowRunId: 7,
	checkedAt: "2026-11-14T11:05:00Z",
	readOnly: true,
	platform: { sha },
	health: { url: failed.smokeUrl, status: 200 },
	version: { url: "https://app.test/version", sha },
	scenario: { url: "https://app.test/", expectedText: "Works", passed: true },
};
function fixture(value: unknown = proof, runs = [baseline]) {
	const reads: number[] = [];
	const unused = async (): Promise<never> => {
		throw new Error("Unexpected mutation or lookup");
	};
	const deploys: ForgeDeploys = {
		listRuns: async () => ({ ok: true, value: runs }),
		readVerificationArtifact: async (_ref, id) => {
			reads.push(id);
			return { ok: true, value };
		},
		resolveCommit: unused,
		readWorkflow: unused,
		listDeployments: unused,
		compare: unused,
		dispatch: unused,
	};
	return {
		reads,
		load: (attempt = failed) =>
			workflowReleaseAnchor(deploys, ref, attempt, new Date("2026-11-14T12:10:00Z")),
	};
}
describe("workflow rollback anchor", () => {
	test("validates historical proof and records provenance without using workflow branch HEAD", async () => {
		const result = await fixture().load();
		expect(result?.expectedSha).toBe(sha);
		expect(result?.verificationPolicy).toEqual(failed.verification);
		expect(result?.anchor).toEqual({
			workflowRunId: 7,
			checkedAt: proof.checkedAt,
			workflow: "deploy.yml",
			artifactName: "proof",
		});
	});
	test("rejects foreign, mismatched or post-incident evidence", async () => {
		for (const patch of [
			{ sha: "d".repeat(40) },
			{ workflowRunId: 6 },
			{ platform: { sha: "d".repeat(40) } },
			{ checkedAt: failed.startedAt },
			{ checkedAt: "2026-11-14T12:01:00Z" },
			{ checkedAt: "2026-11-14T10:59:00Z" },
			{ scenario: { ...proof.scenario, url: "https://other.test/" } },
			{ scenario: { ...proof.scenario, passed: false } },
		])
			await expect(fixture({ ...proof, ...patch }).load()).rejects.toThrow();
	});
	test("accepts only successful runs captured before dispatch", async () => {
		for (const patch of [
			{ id: 8 },
			{ status: "in_progress" },
			{ conclusion: "failure" },
			{ createdAt: failed.startedAt },
			{ createdAt: "invalid" },
		]) {
			const f = fixture(proof, [{ ...baseline, ...patch }]);
			expect(await f.load()).toBeNull();
			expect(f.reads).toEqual([]);
		}
	});
	test("stops on corrupt newest eligible proof instead of selecting an older baseline", async () => {
		const f = fixture({}, [{ ...baseline, id: 6, createdAt: "2026-11-14T10:00:00Z" }, baseline]);
		await expect(f.load()).rejects.toThrow();
		expect(f.reads).toEqual([7]);
	});
	test("refuses an ambiguous workflow title and does not infer proof for HTTP-only policy", async () => {
		await expect(
			fixture(proof, [{ ...baseline, displayTitle: "Deploy main" }]).load(),
		).rejects.toThrow("immutable");
		expect(await fixture().load({ ...failed, verification: undefined })).toBeNull();
	});
});
