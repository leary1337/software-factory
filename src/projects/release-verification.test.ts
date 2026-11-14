import { describe, expect, test } from "bun:test";
import { verifyRelease } from "./release-verification.ts";

const sha = "a".repeat(40);
const verification = {
	versionUrl: "https://app.test/version",
	shaField: "build.commit",
	scenarioUrl: "https://app.test/game",
	expectedText: "Last data update",
};
function run(bodies: Record<string, string>, status = 200) {
	return verifyRelease({
		sha,
		smokeUrl: "https://app.test/health",
		verification,
		timeoutMs: 1000,
		fetch: (async (url, options) => {
			expect(options?.method).toBe("GET");
			return new Response(bodies[String(url)] ?? "ok", { status });
		}) as typeof fetch,
	});
}
describe("verifyRelease", () => {
	test("requires version, availability and the agreed scenario", async () => {
		expect(
			await run({
				[verification.versionUrl]: JSON.stringify({ build: { commit: sha } }),
				[verification.scenarioUrl]: "Last data update: today",
			}),
		).toEqual({ sha, availability: true, version: true, scenario: true });
	});
	test("rejects a wrong SHA and HTTP 200 with a broken scenario", async () => {
		await expect(
			run({ [verification.versionUrl]: JSON.stringify({ build: { commit: "b".repeat(40) } }) }),
		).rejects.toThrow("exact released commit");
		await expect(
			run({
				[verification.versionUrl]: JSON.stringify({ build: { commit: sha } }),
				[verification.scenarioUrl]: "Application error",
			}),
		).rejects.toThrow("scenario failed");
	});
	test("rejects unavailable application and malformed version evidence", async () => {
		await expect(run({}, 503)).rejects.toThrow("HTTP 503");
		await expect(run({ [verification.versionUrl]: "not json" })).rejects.toThrow();
	});
});
