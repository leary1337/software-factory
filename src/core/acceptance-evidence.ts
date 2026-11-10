import type { ReviewGateResult } from "./wire.ts";

export interface AcceptanceCriterion {
	readonly criterion: string;
	readonly checkId: string | null;
}

export interface AcceptanceCheck {
	readonly id: string;
	readonly command: string;
	readonly browser: boolean;
	readonly artifacts: readonly string[];
}

export interface AcceptancePolicy {
	readonly checks: readonly AcceptanceCheck[];
	readonly enforce: boolean;
	readonly requireBrowser: boolean;
}

export interface AcceptanceArtifact {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly text: string | null;
	readonly imageDataUrl: string | null;
}

export interface AcceptanceEvidence extends AcceptanceCriterion {
	readonly commit: string;
	readonly result: ReviewGateResult;
	readonly command: string | null;
	readonly browser: boolean;
	readonly exitCode: number | null;
	readonly reason: string | null;
	readonly artifacts: readonly AcceptanceArtifact[];
}

export interface AcceptanceSummary {
	readonly commit: string;
	readonly verified: boolean;
	readonly enforced: boolean;
	readonly criteria: readonly AcceptanceEvidence[];
}

/** Only task checkboxes under the acceptance heading define acceptance criteria. */
export function parseAcceptanceCriteria(prompt: string): AcceptanceCriterion[] {
	let active = false;
	const criteria: AcceptanceCriterion[] = [];
	for (const line of prompt.split(/\r?\n/)) {
		if (/^#{1,6}\s/.test(line)) {
			active = /^#{1,6}\s+(?:Acceptance criteria|Критерии при[её]мки)\s*$/i.test(line);
			continue;
		}
		if (!active) continue;
		const text = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line)?.[1];
		if (!text) continue;
		if (criteria.length >= 50) {
			criteria.push({
				criterion: "Additional criteria exceed the 50-item verification limit.",
				checkId: null,
			});
			break;
		}
		const checkId = /\[check: ([a-z0-9][a-z0-9-]*)\]/.exec(text)?.[1] ?? null;
		criteria.push({ criterion: text.replace(/\[check: [^\]]+\]\s*/, "").slice(0, 2000), checkId });
	}
	return criteria;
}

/** A matching system event is a runtime receipt; reviewer prose is never evidence. */
export function readAcceptanceSummary(
	events: readonly { kind: string; stream: string | null; payloadJson: unknown }[],
	commit: string | undefined,
): AcceptanceSummary | undefined {
	const last = [...events]
		.reverse()
		.find(
			(event) =>
				event.stream === "system" &&
				["acceptance.started", "acceptance.completed"].includes(event.kind),
		);
	if (last?.kind !== "acceptance.completed") return undefined;
	const value = last.payloadJson as AcceptanceSummary | null;
	return value?.commit === commit && Array.isArray(value?.criteria) ? value : undefined;
}
