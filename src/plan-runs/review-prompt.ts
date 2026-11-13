import type { ReviewFinding } from "../core/review-findings.ts";
import type { ReviewStepRecord } from "./review.ts";
import { parseVerdict } from "./review-result.ts";

export function reviewHistoryPrompt(steps: readonly ReviewStepRecord[], rework: boolean) {
	const captured = [...steps].reverse().find((step) => step.evidence || step.artifacts);
	const prior = captured?.evidence?.findings ?? captured?.artifacts ?? [];
	const legacy = rework ? "" : unmaterializedReports(steps).map(legacyReviewPrompt).join("");
	return { prior, prompt: legacy + reviewEvidencePrompt(prior, rework) };
}

function unmaterializedReports(steps: readonly ReviewStepRecord[]): string[] {
	const reports: string[] = [];
	for (const step of [...steps].reverse()) {
		if (step.evidence) break;
		if (step.step === "rework" || !step.resultText || step.artifacts) continue;
		if (!step.evidenceRequired || step.state === "failed") reports.unshift(step.resultText);
	}
	return reports;
}

export function legacyReviewPrompt(report: string | null | undefined): string {
	if (!report || parseVerdict(report) !== "CHANGES") return "";
	return `\n\n## Unresolved prior review\nThe earlier review has no completed portable evidence. Carry every finding below into this review. Create a portable regression for each, including already fixed cases (which should pass), and verify the current commit. Do not silently drop a finding because a cold review missed it. An unreproducible blocker must be explained explicitly and remains CHANGES. These legacy regressions are NEW artifacts: put every one in the findings array even when it now passes, except ids already listed in Preserved reproductions. There is no prior_regressions field.\n\n${report}`;
}

/** The actual sources travel in durable events and prompts, never ephemeral /tmp links. */
export function reviewEvidencePrompt(prior: readonly ReviewFinding[], rework: boolean): string {
	const sources = `\n\n## Preserved reproductions\n\n${JSON.stringify(prior, null, 2)}`;
	if (rework)
		return `\n\n## Rework completion\nFor each preserved failing reproduction, materialize its exact files in a temporary directory directly under the repository root, export WARREN_REPRO_DIR to that directory and run its command from the repository root. Confirm the original failure and identify the violated invariant. Inspect corresponding paths in the touched module for the same root cause, repair that shared cause, and cover representative valid and invalid inputs in this round. Keep unrelated behavior out of scope. Then rerun every unchanged reproduction and preserve passing cases. Add permanent regression tests to the repository. Run the complete quality gate and commit. Report each finding id and the actual red/green command results. The next independent review reruns the original sources; claiming a finding is fixed does not close it.${sources}`;
	return `\n\n## Durable review protocol (required)\nWarren independently reruns every preserved reproduction after the full quality gate on the pinned commit. Include the existing findings in your review; their original tests remain authoritative for closure.\nWrite $HOME/warren-review.json before finishing, even for PASS, as {"version":1,"findings":[]}. The findings array contains all newly supplied test artifacts: every legacy regression requested above, plus new blocking findings. Exclude only ids already present in Preserved reproductions below, because the runtime retains those exact sources. The only top-level keys are version and findings; do not invent extra keys. Each entry has ${JSON.stringify({ id: "stable-kebab-id", title: "file:line and defect", command: 'node "$WARREN_REPRO_DIR/repro.cjs"', files: [{ path: "repro.cjs", contents: "complete executable source" }] })}. Use valid JSON.\nFor each new finding, include self-contained reproducing test sources with assertions for the required CORRECT behavior. Run them: exit 1 must mean the reported assertion failed; exit 0 must mean the behavior is correct. A missing dependency or skipped test is not evidence. Use installed project tools. Commands run from the repository root after the full gate installs dependencies. WARREN_REPRO_DIR points to a temporary directory directly under that root; use relative imports from there or process.cwd(), never absolute workspace or /tmp paths. File paths are simple basenames, at most 8 files per finding, 32 KiB per file, 32 findings and 128 KiB total. Test sources are immutable between rounds.\nUse CHANGES for any unresolved finding; PASS requires all prior findings addressed and no new blockers. If a blocker cannot be reproduced, explain that limitation explicitly; do not manufacture a passing test. Keep the existing three-line final verdict format and the report readable. Delegating the full gate to the runtime is expected: use QUALITY_GATE: NOT_RUN in the third header and do not repeat that gate under Not run. Use Not run only for required checks that neither you nor the runtime will execute; any such omission requires CHANGES. Optional testing limitations belong under Notes and must not be presented as missing required checks. ${sources}`;
}
