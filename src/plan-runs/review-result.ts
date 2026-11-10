/** The reviewer reports an explicit verdict, commit and quality-gate outcome. */
export function parseVerdict(text: string): "PASS" | "CHANGES" | null {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const first = lines[0];
	if (first !== "VERDICT: PASS" && first !== "VERDICT: CHANGES") return null;
	if (lines.slice(1).some((line) => /^\s*VERDICT:/.test(line))) return null;
	return first === "VERDICT: PASS" ? "PASS" : "CHANGES";
}

export function passedReviewCommit(text: string): string | null {
	if (parseVerdict(text) !== "PASS") return null;
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	const commit = /^REVIEWED_COMMIT: ([a-f0-9]{40})$/.exec(lines[1] ?? "")?.[1];
	if (!commit || lines[2] !== "QUALITY_GATE: PASS") return null;
	if (lines.slice(3).some((line) => /^\s*(?:REVIEWED_COMMIT:|QUALITY_GATE:|Not run:)/i.test(line)))
		return null;
	return commit;
}
