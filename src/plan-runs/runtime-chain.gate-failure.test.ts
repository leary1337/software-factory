import { expect, test } from "bun:test";
import { runtimeChain } from "./runtime-chain.test-helpers.ts";

test.skipIf(process.platform !== "darwin")(
	"reaps a real independent gate failure and dispatches rework without operator reconciliation",
	async () => {
		const h = await runtimeChain(["CHANGES", "WAIT"], "exit 1");
		try {
			await h.advance();
			await h.drain();
			await h.advance();
			await h.drain();
			const runs = await h.repos.runs.listByState([
				"queued",
				"running",
				"failed",
				"succeeded",
				"cancelled",
			]);
			const reviewer = runs.find((run) => run.agentName === "reviewer");
			expect(reviewer).toMatchObject({ state: "failed", failureReason: "crashed" });
			const events = await h.repos.events.listByRun(reviewer?.id ?? "");
			expect(events.some((event) => event.kind === "review.check_failed")).toBe(true);
			expect(
				events.some(
					(event) =>
						event.kind === "state_change" &&
						(event.payloadJson as { is_error?: boolean }).is_error === true,
				),
			).toBe(true);
			await h.advance();
			await h.drain();
			expect(h.roles).toEqual(["implementer", "reviewer", "rework"]);
			expect(h.forge.merges).toBe(0);
		} finally {
			await h.close();
		}
	},
	30000,
);
