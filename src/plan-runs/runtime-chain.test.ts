import { expect, test } from "bun:test";
import { join } from "node:path";
import { reapRun } from "../runs/index.ts";
import { LocalProvider } from "../runtime/local/provider.ts";
import { bootBridges } from "../server/bridges.ts";
import { cancelPlanRun } from "./cancel.ts";
import { runtimeChain } from "./runtime-chain.test-helpers.ts";

for (const verdicts of [
	["PASS"],
	["CHANGES", "PASS"],
	["CHANGES", "CHANGES", "CHANGES", "PASS"],
	["STALLED", "PASS"],
	["CRASH"],
	["CRASH", "CRASH", "CRASH"],
]) {
	test.skipIf(process.platform !== "darwin")(
		`runs the real sandbox factory chain: ${verdicts.join(" → ")}`,
		async () => {
			const expectedReworks =
				verdicts.filter((v) => v === "CHANGES" || v === "STALLED").length +
				(verdicts.includes("STALLED") ? 1 : 0);
			const succeeds =
				!verdicts.includes("STALLED") && verdicts.filter((v) => v === "CRASH").length < 3;
			const h = await runtimeChain([...verdicts]);
			try {
				for (let i = 0; i < 25; i++) {
					await h.advance();
					await h.drain();
					if (h.forge.merges === 0)
						expect(h.roles.filter((role) => role === "implementer")).toHaveLength(1);
					const plan = await h.repos.planRuns.require(h.planRun.id);
					if (["succeeded", "failed"].includes(plan.state)) break;
				}
				const plan = await h.repos.planRuns.require(h.planRun.id);
				const runs = await h.repos.runs.listByState([
					"queued",
					"running",
					"failed",
					"succeeded",
					"cancelled",
				]);
				expect({
					state: plan.state,
					roles: h.roles,
					failures: runs.filter((r) => r.state === "failed").map((r) => r.failureReason),
				}).toMatchObject({ state: succeeds ? "succeeded" : "running" });
				expect(h.roles.filter((r) => r === "rework")).toHaveLength(expectedReworks);
				expect(h.forge.merges).toBe(succeeds ? 2 : 0);
				if (!succeeds) {
					const parent = runs.find((r) => r.agentName === "implementer");
					expect(parent).toBeDefined();
					const events = await h.repos.events.listByRun(parent?.id ?? "");
					expect(
						events.find((e) => e.kind === "plan_run.review_finished")?.payloadJson,
					).toMatchObject({ outcome: verdicts.includes("CRASH") ? "broken" : "changes_left" });
				}
				const merged = h.forge.merges;
				await h.advance();
				expect(h.forge.merges).toBe(merged);
			} finally {
				await h.close();
			}
		},
		30_000,
	);
}

for (const action of ["cancel", "restart"] as const) {
	test.skipIf(process.platform !== "darwin")(
		`stops the real reviewer on ${action} and never dispatches the next ticket`,
		async () => {
			const h = await runtimeChain(["WAIT", "WAIT"]);
			try {
				await h.advance();
				await h.drain();
				await h.advance();
				for (let i = 0; i < 250 && !h.store.list().some((r) => r.phase === "running"); i++)
					await Bun.sleep(20);
				const reviewer = (await h.repos.runs.listByState(["queued", "running"])).find(
					(r) => r.agentName === "reviewer",
				);
				if (!reviewer?.sandboxId || !reviewer.sandboxRunId) throw new Error("reviewer missing");
				const handle = {
					runId: reviewer.id,
					sandboxId: reviewer.sandboxId,
					providerRunId: reviewer.sandboxRunId,
				};
				const record = h.store.getByRunId(handle.providerRunId);
				expect(record?.proc).toBeDefined();
				if (action === "cancel") {
					await cancelPlanRun({
						planRunId: h.planRun.id,
						repos: h.repos,
						runtimeProvider: h.provider,
						broker: h.broker,
						reap: (input) => reapRun({ ...input, forge: h.forge }),
					});
					expect((await h.repos.planRuns.require(h.planRun.id)).state).toBe("cancelled");
				} else {
					await h.bridges.stopAll();
					await h.provider.cancel(handle);
					const restarted = new LocalProvider({
						serverEnv: { WARREN_DATA_DIR: join(h.root, "data") },
					});
					const booted = await bootBridges({
						repos: h.repos,
						broker: h.broker,
						runtimeProvider: restarted,
					});
					await booted.registry.stopAll();
					expect((await h.repos.runs.require(reviewer.id)).failureReason).toBe("sandbox_run_lost");
					await h.advance();
				}
				await h.advance();
				expect(h.roles).toEqual(
					action === "cancel"
						? ["implementer", "reviewer"]
						: ["implementer", "reviewer", "reviewer"],
				);
				const children = await h.repos.planRuns.listChildren(h.planRun.id);
				if (action === "restart") expect(children[1]?.state).toBe("pending");
				expect(h.forge.merges).toBe(0);
				await record?.driveDone;
				expect((await h.repos.runs.require(reviewer.id)).state).toBe(
					action === "cancel" ? "cancelled" : "failed",
				);
			} finally {
				await h.close();
			}
		},
		20_000,
	);
}
