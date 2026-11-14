import { ValidationError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EffectIntent } from "../db/repos/plan-effects.ts";
import { withPlanRunLock } from "./lock.ts";

export type EffectObservation =
	| { kind: "confirmed"; result: Record<string, unknown> }
	| { kind: "absent" }
	| { kind: "unknown"; reason: string }
	| { kind: "rejected"; reason: string };
export interface ReconcileEffectInput extends EffectIntent {
	/** Absence must be conclusive, not an eventually consistent empty search. */
	lookup: () => Promise<EffectObservation>;
	perform: () => Promise<Exclude<EffectObservation, { kind: "absent" }>>;
}
/** Record intent first; repeated calls reconcile the provider before repeating any mutation. */
export async function reconcileEffect(
	repos: Pick<Repos, "planEffects">,
	input: ReconcileEffectInput,
): Promise<Exclude<EffectObservation, { kind: "absent" }>> {
	return withPlanRunLock(`effect:${input.identity}`, async () => {
		const fresh = await repos.planEffects.claim(input);
		const row = await repos.planEffects.get(input.identity);
		assertIdentity(row, input);
		if (row.state === "confirmed") return { kind: "confirmed", result: row.result ?? {} };
		if (row.state === "rejected")
			return { kind: "rejected", reason: row.reason ?? "Action rejected" };
		try {
			const result = await observeOrPerform(fresh, input);
			await repos.planEffects.record(
				input.identity,
				result.kind,
				result.kind === "confirmed" ? result.result : null,
				result.kind === "confirmed" ? null : result.reason,
			);
			return result;
		} catch {
			const reason =
				"The external action outcome is unknown; waiting for reconciliation before continuing.";
			await repos.planEffects.record(input.identity, "unknown", row.result, reason);
			return { kind: "unknown", reason };
		}
	});
}

function assertIdentity(
	row: Awaited<ReturnType<Repos["planEffects"]["get"]>>,
	intent: EffectIntent,
): asserts row is NonNullable<typeof row> {
	if (
		!row ||
		row.planRunId !== intent.planRunId ||
		row.seq !== intent.seq ||
		row.kind !== intent.kind ||
		row.target !== intent.target
	)
		throw new ValidationError("External action identity conflicts with an existing intent");
}

async function observeOrPerform(fresh: boolean, input: ReconcileEffectInput) {
	const observed = fresh ? { kind: "absent" as const } : await input.lookup();
	return observed.kind === "absent" ? input.perform() : observed;
}
