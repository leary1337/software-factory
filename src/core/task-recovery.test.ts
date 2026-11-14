import { describe, expect, test } from "bun:test";
import { projectTaskRecovery, type RecoveryEvent } from "./task-recovery.ts";

const event = (kind: string, payload: unknown = {}): RecoveryEvent => ({
	kind,
	payload,
	ts: "2026-11-14T12:00:00Z",
});
const proof = {
	expectedSha: "a".repeat(40),
	verification: { availability: true, version: true, scenario: true },
};
describe("projectTaskRecovery", () => {
	test("keeps normal successful preparation out of recovery presentation", () => {
		expect(
			projectTaskRecovery([event("preparation.started"), event("preparation.completed")]),
		).toEqual({ preparation: null, rollback: null });
	});
	test("counts admitted repairs and retains the original cause when a third attempt is denied", () => {
		const result = projectTaskRecovery([
			event("preparation.repair_started", {
				attempt: 1,
				reason: "Registry timeout",
				action: "Retry dependency install",
			}),
			event("preparation.repair_started", {
				attempt: 2,
				reason: "Registry timeout",
				action: "Retry dependency install",
			}),
			event("preparation.repair_stopped", { attempt: 3, reason: "Task repair budget exhausted" }),
			event("preparation.failed", { message: "Task repair budget exhausted" }),
		]);
		expect(result.preparation).toMatchObject({
			state: "stopped",
			attempt: 2,
			reason: "Registry timeout",
			stopReason: "Task repair budget exhausted",
		});
		expect(result.preparation?.nextAction).toContain("before resuming");
	});
	test("presents a retry in progress, then recovered setup without claiming task success", () => {
		const events = [
			event("preparation.repair_started", {
				attempt: 1,
				reason: "HTTP 503",
				action: "Retry install",
			}),
		];
		expect(projectTaskRecovery(events).preparation).toMatchObject({
			state: "repairing",
			attempt: 1,
			action: "Retry install",
		});
		events.push(event("preparation.completed"));
		expect(projectTaskRecovery(events).preparation).toMatchObject({
			state: "recovered",
			attempt: 1,
			reason: "HTTP 503",
		});
	});
	test("does not count an unapproved first repair as executed", () => {
		expect(
			projectTaskRecovery([
				event("preparation.repair_stopped", { attempt: 1, reason: "No approved budget" }),
			]).preparation,
		).toMatchObject({ state: "stopped", attempt: 0, reason: "No approved budget" });
	});
	test("keeps a nonrepairable environment failure separate from implementation", () => {
		expect(
			projectTaskRecovery([event("preparation.failed", { message: "Lockfile is missing" })])
				.preparation,
		).toMatchObject({ state: "failed", attempt: 0, reason: "Lockfile is missing" });
	});
	test("keeps rollback running until all checks confirm the exact restored SHA", () => {
		const events = [
			event("plan_run.rollback_attempt", {
				expectedSha: proof.expectedSha,
				reason: "Browser check failed",
			}),
		];
		expect(projectTaskRecovery(events).rollback).toEqual({
			state: "running",
			sha: proof.expectedSha,
			reason: "Browser check failed",
		});
		events.push(event("plan_run.rollback_verified", { ...proof, reason: "Browser check failed" }));
		expect(projectTaskRecovery(events).rollback).toMatchObject({
			state: "verified",
			reason: "Browser check failed",
		});
		events.push(
			event("plan_run.deployment_verified", {
				...proof,
				expectedSha: "b".repeat(40),
				environment: "production",
			}),
		);
		expect(projectTaskRecovery(events).rollback?.state).toBe("released");
	});
	test("never promotes incomplete rollback evidence to restored", () => {
		for (const payload of [
			null,
			{ expectedSha: proof.expectedSha },
			{ ...proof, expectedSha: "invalid" },
			{ ...proof, verification: { availability: true, version: true, scenario: false } },
		])
			expect(
				projectTaskRecovery([event("plan_run.rollback_verified", payload)]).rollback,
			).toMatchObject({ state: "failed", reason: "Rollback verification evidence is incomplete." });
	});
	test("rejects a rollback receipt for another target or an unknown time", () => {
		const started = event("plan_run.rollback_attempt", { expectedSha: "b".repeat(40) });
		expect(
			projectTaskRecovery([started, event("plan_run.rollback_verified", proof)]).rollback?.state,
		).toBe("failed");
		expect(
			projectTaskRecovery([{ ...event("plan_run.rollback_verified", proof), ts: "" }]).rollback
				?.state,
		).toBe("failed");
	});
	test("retains stopped rollback reason and does not infer success from unrelated events", () => {
		expect(
			projectTaskRecovery([
				event("plan_run.rollback_failed", { reason: "No compatible previous release" }),
				event("run.succeeded"),
				event("plan_run.deployment_verified", null),
			]).rollback,
		).toEqual({ state: "failed", sha: null, reason: "No compatible previous release" });
	});
	test("does not clear restoration warnings for legacy deployment receipts lacking environment or time", () => {
		const restored = event("plan_run.rollback_verified", proof);
		for (const receipt of [
			event("plan_run.deployment_verified", proof),
			event("plan_run.deployment_verified", { ...proof, environment: " " }),
			{
				...event("plan_run.deployment_verified", { ...proof, environment: "production" }),
				ts: "invalid",
			},
		])
			expect(projectTaskRecovery([restored, receipt]).rollback?.state).toBe("verified");
	});
	test("reports the new environment failure after a stopped earlier attempt", () => {
		const events = [
			event("preparation.repair_started", { reason: "Registry timeout", action: "Retry install" }),
			event("preparation.repair_stopped", { reason: "Repair budget exhausted" }),
			event("preparation.failed", { message: "Repair budget exhausted" }),
			event("preparation.started"),
			event("preparation.failed", { message: "Required uv version is unavailable" }),
		];
		expect(projectTaskRecovery(events).preparation).toMatchObject({
			state: "failed",
			attempt: 1,
			reason: "Required uv version is unavailable",
		});
	});
	test("bounds malformed event details and keeps recovery absent without events", () => {
		expect(projectTaskRecovery([])).toEqual({ preparation: null, rollback: null });
		expect(
			projectTaskRecovery([event("preparation.failed", { message: "x".repeat(8000) })]).preparation
				?.reason,
		).toHaveLength(1000);
		expect(projectTaskRecovery([event("preparation.failed", null)]).preparation?.reason).toBe(
			"Environment preparation failed.",
		);
	});
});
