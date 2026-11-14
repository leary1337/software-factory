#!/usr/bin/env bun
/** Real Codex acceptance. Never targets the running factory, GitHub repositories or a VPS. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexAuthFile } from "../../src/runtime/adapters/codex-credentials.ts";
import { fixtureGitOrThrow as git } from "../../src/workspace/git/test-fixture.ts";
import { realPlanHarness } from "./harness.ts";

const startedAt = new Date();
const h = await realPlanHarness();
console.log(
	JSON.stringify({
		stage: "acceptance_started",
		root: h.fixture.root,
		planRunId: h.planRun.id,
		approvalId: h.approval.id,
		toolkitVersion: h.toolkit.version,
		initialSha: h.fixture.initialSha,
		authAvailable: await Bun.file(codexAuthFile()).exists(),
	}),
);
let outcome = "failed";
let failure: string | undefined;
try {
	const deadline = Date.now() + 45 * 60_000;
	let previous = "";
	while (Date.now() < deadline) {
		const decision = await h.advance();
		const plan = await h.repos.planRuns.require(h.planRun.id);
		const children = await h.repos.planRuns.listChildren(plan.id);
		const active = await h.repos.runs.listByState(["queued", "running"]);
		const summary = JSON.stringify({
			state: plan.state,
			decision: decision.kind,
			children: children.map((child) => ({ seq: child.seq, state: child.state })),
			active: active.map((run) => ({ id: run.id, role: run.agentName, state: run.state })),
		});
		if (summary !== previous) {
			console.log(summary);
			previous = summary;
		}
		if (plan.state === "failed" || plan.state === "cancelled")
			throw new Error(`Plan ended ${plan.state}: ${plan.failureReason}`);
		if (plan.state === "succeeded") {
			if (h.forge.merges.length !== 3 || h.forge.releases.length !== 1)
				throw new Error("Expected three reviewed merges and exactly one final release");
			const sha = (await git(h.fixture.remote, ["rev-parse", "main"])).stdout.trim();
			const version = (await (await fetch(`${h.fixture.base}/version`)).json()) as { sha: string };
			if (version.sha !== sha) throw new Error("Application SHA differs from merged main");
			const runs = await h.repos.runs.listByProject(h.project.id, { limit: 100 });
			const reviews = runs.filter((run) => run.agentName === "reviewer");
			if (reviews.length < 4) throw new Error("Code and rendered UI reviews were not all executed");
			const events = await h.repos.events.listByRunIds(runs.map((run) => run.id));
			if (
				!events.some(
					(event) =>
						event.kind === "plan_run.review_step" &&
						(event.payloadJson as { step?: string }).step === "ui_review",
				)
			)
				throw new Error("Independent rendered UI reviewer witness missing");
			if (events.filter((event) => event.kind === "quality_gate.completed").length < 4)
				throw new Error("Independent gate witnesses missing");
			if (events.filter((event) => event.kind === "plan_run.release_pending").length !== 2)
				throw new Error("Intermediate merged work did not wait for the release boundary");
			outcome = "succeeded";
			break;
		}
		await Bun.sleep(2000);
	}
	if (outcome !== "succeeded") throw new Error("Acceptance plan exceeded its wall-clock budget");
} catch (error) {
	failure = error instanceof Error ? error.message : String(error);
	console.error(JSON.stringify({ stage: "acceptance_failed", failure }));
} finally {
	const runs = await h.repos.runs.listByProject(h.project.id, { limit: 100 });
	const events = await h.repos.events.listByRunIds(runs.map((run) => run.id));
	const evidence = {
		outcome,
		failure,
		startedAt: startedAt.toISOString(),
		endedAt: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt.getTime(),
		root: h.fixture.root,
		initialSha: h.fixture.initialSha,
		finalSha: (await git(h.fixture.remote, ["rev-parse", "main"])).stdout.trim(),
		approvalId: h.approval.id,
		approvalRevision: h.approval.revision,
		approvalDigest: h.approval.digest,
		toolkitVersion: h.toolkit.version,
		model: "gpt-6.1-sol",
		realCodex: true,
		platform: "local bare Git and explicit FakeForge",
		actualApplication: true,
		manualRepairs: 0,
		merges: h.forge.merges,
		releases: h.forge.releases,
		runs: runs.map((run) => ({
			id: run.id,
			role: run.agentName,
			state: run.state,
			failureReason: run.failureReason,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			tokensInput: run.tokensInput,
			tokensOutput: run.tokensOutput,
			tokensCacheRead: run.tokensCacheRead,
		})),
		witnesses: events
			.filter((event) =>
				[
					"preparation.started",
					"preparation.completed",
					"preparation.failed",
					"preparation.repair_started",
					"quality_gate.completed",
					"plan_run.release_pending",
					"plan_run.deployment_verified",
					"plan_run.review_finished",
					"plan_run.review_step",
				].includes(event.kind),
			)
			.map((event) => ({
				runId: event.runId,
				kind: event.kind,
				ts: event.ts,
				payload: event.payloadJson,
			})),
	};
	await writeFile(join(h.fixture.root, "evidence.json"), JSON.stringify(evidence, null, 2));
	await h.close();
	console.log(
		JSON.stringify({
			stage: "acceptance_stopped",
			outcome,
			evidence: join(h.fixture.root, "evidence.json"),
			authAvailable: await Bun.file(codexAuthFile()).exists(),
		}),
	);
}
if (outcome !== "succeeded") process.exitCode = 1;
