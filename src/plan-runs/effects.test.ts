import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { approvedFixture } from "./approval-test-helpers.ts";
import { reconcileEffect } from "./effects.ts";

let fixture: Awaited<ReturnType<typeof approvedFixture>>;
beforeEach(async () => {
	fixture = await approvedFixture();
});
afterEach(async () => {
	await fixture.dispose();
});
describe("external effect reconciliation", () => {
	test("adopts an effect that succeeded before the response was lost, including after restart", async () => {
		let mutations = 0;
		const intent = {
			identity: "merge:sha",
			planRunId: fixture.planRun.id,
			seq: 1,
			kind: "merge" as const,
			target: "sha",
		};
		const first = await reconcileEffect(fixture.repos, {
			...intent,
			lookup: async () => ({ kind: "absent" }),
			perform: async () => {
				mutations++;
				throw new Error("response lost");
			},
		});
		expect(first.kind).toBe("unknown");
		await fixture.reopen();
		const second = await reconcileEffect(fixture.repos, {
			...intent,
			lookup: async () => ({ kind: "confirmed", result: { sha: "sha" } }),
			perform: async () => {
				mutations++;
				return { kind: "confirmed", result: {} };
			},
		});
		expect(second).toEqual({ kind: "confirmed", result: { sha: "sha" } });
		expect(mutations).toBe(1);
	});
	test("holds dependent work while the provider cannot establish an outcome", async () => {
		const intent = {
			identity: "deploy:sha",
			planRunId: fixture.planRun.id,
			seq: 1,
			kind: "deploy" as const,
			target: "sha",
		};
		await fixture.repos.planEffects.claim(intent);
		const result = await reconcileEffect(fixture.repos, {
			...intent,
			lookup: async () => ({ kind: "unknown", reason: "Provider unreachable" }),
			perform: async () => {
				throw new Error("must not repeat");
			},
		});
		expect(result).toEqual({ kind: "unknown", reason: "Provider unreachable" });
		expect((await fixture.repos.planEffects.get(intent.identity))?.state).toBe("unknown");
	});
});
