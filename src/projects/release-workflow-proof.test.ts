import { describe, expect, test } from "bun:test";
import type { RepoRef } from "../forge/contract.ts";
import { verifyRelease } from "./release-verification.ts";

const sha = "a".repeat(40);
const verification = {
	artifactName: "factory-verification",
	versionUrl: "https://app.test/version",
	scenarioUrl: "https://app.test/",
	expectedText: "Data updated",
};
const proof = {
	schemaVersion: 1,
	sha,
	workflowRunId: 7,
	checkedAt: "2026-11-14T12:01:00Z",
	readOnly: true,
	platform: { sha },
	health: { url: "https://app.test/health", status: 200 },
	version: { url: verification.versionUrl, sha },
	scenario: {
		url: verification.scenarioUrl,
		expectedText: verification.expectedText,
		passed: true,
	},
};
const unused = async () => ({
	ok: false as const,
	error: { kind: "http_error" as const, detail: "Unexpected forge operation" },
});
const run = (value: unknown) =>
	verifyRelease({
		sha,
		smokeUrl: proof.health.url,
		verification,
		timeoutMs: 500,
		fetch: (async () => {
			throw new Error("Must not contact the protected application from the Mac");
		}) as unknown as typeof fetch,
		workflow: {
			ref: { forge: "github", key: "o/r" } as RepoRef,
			runId: 7,
			startedAt: "2026-11-14T12:00:00Z",
			now: new Date("2026-11-14T12:02:00Z"),
			deploys: {
				readVerificationArtifact: async () => ({ ok: true, value }),
				listDeployments: unused,
				compare: unused,
				listRuns: unused,
				resolveCommit: unused,
				readWorkflow: unused,
				dispatch: unused,
			},
		},
	});
describe("workflow application proof", () => {
	test("accepts exact read-only evidence without copying protected credentials to the Mac", async () => {
		expect(await run(proof)).toEqual({
			sha,
			availability: true,
			version: true,
			scenario: true,
			workflowRunId: 7,
			checkedAt: proof.checkedAt,
		});
	});
	test("rejects a success claim for the wrong revision, run, time or scenario", async () => {
		for (const patch of [
			{ sha: "b".repeat(40) },
			{ workflowRunId: 8 },
			{ platform: { sha: "b".repeat(40) } },
			{ checkedAt: "2026-11-13T12:00:00Z" },
			{ checkedAt: "2026-11-15T12:00:00Z" },
			{ health: { ...proof.health, status: 503 } },
			{ scenario: { ...proof.scenario, passed: false } },
			{ scenario: { ...proof.scenario, expectedText: "Another scenario" } },
			{ version: { ...proof.version, sha: "b".repeat(40) } },
		]) {
			await expect(run({ ...proof, ...patch })).rejects.toThrow();
		}
	});
});
