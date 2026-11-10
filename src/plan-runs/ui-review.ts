import type { HandleInFlightInput } from "./in-flight.ts";
import type { ReviewDecision, ReviewStepRecord } from "./review.ts";

export function touchesUi(paths: readonly string[]): boolean {
	return paths.some(
		(path) =>
			/\.(?:tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i.test(path) ||
			/(?:^|\/)(?:ui|frontend|components|pages|styles|public)\//.test(path),
	);
}

/** An unreadable diff must not silently skip the rendered-interface review. */
export async function includeUiReview(
	input: HandleInFlightInput,
	branch: string | null,
	prUrl: string,
	last: ReviewStepRecord | undefined,
	decision: ReviewDecision,
): Promise<ReviewDecision> {
	if (
		decision.kind !== "finished" ||
		decision.outcome !== "passed" ||
		last?.step !== "review" ||
		!input.getReviewChangedPaths
	)
		return decision;
	if (!branch || !last.reviewedCommit) return { kind: "wait" };
	const paths = await input.getReviewChangedPaths(
		prUrl,
		branch,
		input.planRun.projectId,
		last.reviewedCommit,
	);
	if (paths === null) return { kind: "wait" };
	return touchesUi(paths)
		? { kind: "spawn", step: "ui_review", reviewedCommit: last.reviewedCommit }
		: decision;
}

export const UI_REVIEW_PROMPT = `This is a separate UI/UX review after the code review. Inspect the changed interface and the ticket acceptance criteria. Run the project's documented browser/visual verification against the actual rendered app. Check the affected workflows, loading/empty/error states, accessibility, overflow at phone (393px) and desktop (1440px), and supported light/dark themes. Read the project's verification skill for setup and available browser tools. Report the commands and observations you actually obtained; never invent screenshots or claim an unrun check passed. If browser verification is unavailable or the interface is broken, return CHANGES and describe the blocker. Leave the complete quality gate to the independent runtime check as usual.`;
