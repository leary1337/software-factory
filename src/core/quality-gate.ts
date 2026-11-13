/** Runtime witnesses are separate from the reviewer's prose claims. */
export interface QualityGateEvent {
	readonly kind: string;
	readonly stream: string | null;
	readonly payloadJson: unknown;
}

export function hasQualityGateWitness(
	events: readonly QualityGateEvent[],
	commit: string,
): boolean {
	if (!/^[a-f0-9]{40}$/.test(commit)) return false;
	const event = [...events]
		.reverse()
		.find(
			(candidate) =>
				candidate.stream === "system" &&
				(candidate.kind === "quality_gate.completed" || candidate.kind === "quality_gate.started"),
		);
	if (event?.kind !== "quality_gate.completed") return false;
	{
		const data = event.payloadJson;
		if (typeof data !== "object" || data === null) return false;
		const witness = data as Record<string, unknown>;
		return (
			witness.commit === commit &&
			witness.exitCode === 0 &&
			typeof witness.command === "string" &&
			witness.command.trim().length > 0
		);
	}
}

/** Reconcile the machine-owned check result while preserving every review finding. */
export function reportWithVerifiedGate(text: string, commit: string): string {
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	if (lines[1] !== `REVIEWED_COMMIT: ${commit}` || lines[2] !== "QUALITY_GATE: NOT_RUN")
		return text;
	lines[2] = "QUALITY_GATE: PASS";
	for (let index = 3; index < lines.length; index++) {
		if (lines[index] === "RUNTIME_GATE: DEFERRED") lines[index] = "RUNTIME_GATE: VERIFIED";
	}
	return lines.join("\n");
}
