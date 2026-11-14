import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalProvider } from "../runtime/local/provider.ts";
import { bootBridges } from "../server/bridges.ts";
import { runtimeChain } from "./runtime-chain.test-helpers.ts";
import { taskBudgetUsage } from "./task-budget.ts";

for (const role of ["implementer", "reviewer", "rework"]) {
	test.skipIf(process.platform !== "darwin")(
		`recovers a killed ${role} with saved work, fresh session and the same durable budget`,
		async () => {
			const h = await runtimeChain(role === "rework" ? ["CHANGES", "PASS"] : ["PASS"], undefined, {
				approved: true,
				pauseRole: role,
			});
			try {
				for (let tick = 0; tick < 5 && !h.roles.includes(role); tick++) {
					await h.advance();
					if (!h.roles.includes(role)) await h.drain();
				}
				let record = h.store.list().find((row) => row.phase === "running" && row.proc !== null);
				for (let n = 0; n < 250; n++) {
					record = h.store.list().find((row) => row.phase === "running" && row.proc !== null);
					if (record && (await Bun.file(join(record.workspacePath, "interrupted-ready")).exists()))
						break;
					await Bun.sleep(20);
				}
				if (
					!record?.proc ||
					!(await Bun.file(join(record.workspacePath, "interrupted-ready")).exists())
				)
					throw new Error(`No paused ${role}: ${JSON.stringify(h.roles)}`);
				const prior = await h.repos.runs.require(record.runId);
				await h.bridges.stopAll();
				process.kill(record.proc.pid, "SIGKILL");
				await record.driveDone;
				const restarted = new LocalProvider({
					serverEnv: { WARREN_DATA_DIR: join(h.root, "data") },
				});
				const booted = await bootBridges({
					repos: h.repos,
					broker: h.broker,
					runtimeProvider: restarted,
				});
				await booted.registry.stopAll();
				const lost = await h.repos.runs.require(prior.id);
				expect(lost.failureReason).toBe("sandbox_run_lost");
				expect(lost.salvagePath).not.toBeNull();
				const next = await h.advance();
				expect(next.kind).toBe("dispatched");
				await h.drain();
				const usage = await taskBudgetUsage(h.repos, h.planRun.id, 1);
				expect(usage.repairs).toBe(1);
				const attempts = await h.repos.runs.listByState([
					"succeeded",
					"failed",
					"queued",
					"running",
				]);
				const recovered = attempts.find((run) => run.retryOf === prior.id);
				expect(recovered?.agentName).toBe(role);
				expect(recovered?.id).not.toBe(prior.id);
				if (role !== "reviewer") {
					const exported = Bun.spawn(
						[
							"git",
							"--git-dir",
							join(h.root, "remote.git"),
							"show",
							`${recovered?.branch}:preserved.txt`,
						],
						{ stdout: "pipe", stderr: "pipe" },
					);
					const contents = await new Response(exported.stdout).text();
					await exported.exited;
					expect(contents).toBe("pending\n");
				}
				expect(await readFile(lost.salvagePath ?? "missing")).not.toHaveLength(0);
			} finally {
				await h.close();
			}
		},
		30_000,
	);
}
