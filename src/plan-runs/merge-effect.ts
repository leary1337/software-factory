import { type ReviewMergeResult, readReviewMergeResult } from "../core/review-merge.ts";
import { reconcileEffect } from "./effects.ts";
import type { HandleInFlightInput } from "./in-flight.ts";

/** Read the forge before repeating a merge whose response might have been lost. */
export async function reconcileMerge(
	input: HandleInFlightInput,
	prUrl: string,
	commit: string,
	perform: () => Promise<ReviewMergeResult>,
): Promise<ReviewMergeResult> {
	if (!input.repos.planEffects) return perform();
	const result = await reconcileEffect(
		{ planEffects: input.repos.planEffects },
		{
			identity: `${input.planRun.id}:${input.child.seq}:merge:${commit}`,
			planRunId: input.planRun.id,
			seq: input.child.seq,
			kind: "merge",
			target: commit,
			lookup: async () => {
				const observed = await input.checkPrMerged(prUrl);
				if (observed.kind === "merged") return { kind: "confirmed", result: { kind: "merged" } };
				if (observed.kind === "open") return { kind: "absent" };
				return { kind: "unknown", reason: "The forge has not confirmed the merge outcome" };
			},
			perform: async () => {
				const outcome = await perform();
				if (outcome.kind === "merged") return { kind: "confirmed", result: { ...outcome } };
				// A classified policy/check wait is safe to re-evaluate after another forge read.
				return { kind: "unknown", reason: JSON.stringify(outcome) };
			},
		},
	);
	if (result.kind === "confirmed")
		return readReviewMergeResult(result.result) ?? { kind: "merged" };
	try {
		const previous = readReviewMergeResult(JSON.parse(result.reason));
		if (previous) return previous;
	} catch {
		/* plain diagnostic */
	}
	return {
		kind: "retry",
		reason: "merge_confirmation_pending",
		detail: result.reason,
		nextAction: "The factory will reconcile this merge before continuing.",
	};
}
