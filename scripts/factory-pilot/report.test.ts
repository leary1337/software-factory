import { describe, expect, test } from "bun:test";
import { assertPilotRepository, pilotStopped, summarizePilot } from "./report.ts";

describe("factoryPilot", () => {
	test("rejects other projects and accepts standard sandbox remote forms", () => {
		for (const url of [
			"https://github.com/leary1337/factory-sandbox",
			"git@github.com:leary1337/factory-sandbox.git",
			"ssh://git@github.com/leary1337/factory-sandbox",
		])
			expect(() => assertPilotRepository(url)).not.toThrow();
		for (const url of [
			"https://github.com/leary1337/gym-crew",
			"https://github.com/leary1337/factory-sandbox.evil",
			"https://example.com/leary1337/factory-sandbox",
		])
			expect(() => assertPilotRepository(url)).toThrow();
	});
	test("does not turn a policy-blocked successful review into a successful pilot", () => {
		const summary = summarizePilot({
			planRun: { id: "p", state: "running" },
			children: [
				{
					reviewStage: "needs_attention",
					reviewMerge: { kind: "blocked", reason: "protection_required" },
					reviewSteps: [{ summary: { verdict: "PASS", gateVerified: true } }],
				},
			],
		});
		expect(pilotStopped(summary)).toBe(true);
		expect(summary.state).toBe("running");
		expect(summary.children[0]?.mergeReason).toBe("protection_required");
	});
	test("exports evidence hashes without prompts, screenshots or token values", () => {
		const summary = summarizePilot({
			planRun: { state: "succeeded", promptTemplate: "secret" },
			runs: [{ prompt: "secret", token: "secret" }],
			children: [
				{
					reviewSteps: [
						{
							summary: {
								acceptance: {
									verified: true,
									criteria: [
										{
											checkId: "ui",
											result: "PASS",
											browser: true,
											artifacts: [{ path: "shot.png", sha256: "digest", imageDataUrl: "secret" }],
										},
									],
								},
							},
						},
					],
				},
			],
		});
		expect(JSON.stringify(summary)).not.toContain("secret");
		expect(summary.children[0]?.reviews[0]?.criteria[0]?.artifacts).toEqual([
			{ path: "shot.png", sha256: "digest" },
		]);
		expect(pilotStopped(summary)).toBe(true);
	});
	test("stops only after budget admission actually refuses a dispatch", () => {
		const detail = (awaitingDispatch: boolean) => ({
			planRun: { state: "running" },
			children: [
				{ budget: { blocked: true, awaitingDispatch, reason: "Task run budget reached (8/8)." } },
			],
		});
		expect(pilotStopped(summarizePilot(detail(false)))).toBe(false);
		const stopped = summarizePilot(detail(true));
		expect(pilotStopped(stopped)).toBe(true);
		expect(stopped.children[0]?.budgetReason).toBe("Task run budget reached (8/8).");
	});
	test("keeps incomplete live work pending", () => {
		expect(
			pilotStopped(
				summarizePilot({ planRun: { state: "running" }, children: [{ state: "dispatched" }] }),
			),
		).toBe(false);
	});
});
