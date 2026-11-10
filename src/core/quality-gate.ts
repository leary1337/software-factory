/**
 * The post-run quality gate's event shape, shared by its producer and its
 * consumers (docs/design/post-run-quality-gate.md).
 *
 * The local drive loop (`src/runtime/local/post-run-gate.ts`) runs the
 * project's `qualityGate` command inside the run's own sandbox once the agent
 * exits, and appends one `quality_gate` event when the command starts and one
 * when it finishes. The plan-run review step (`src/plan-runs/review.ts`)
 * reads the finished event back off the run to decide between rework and
 * review, and to tell the reviewer what already ran.
 *
 * `src/core/` imports nothing (check:layers), so the reader below is
 * structural over `unknown`.
 */

/** The event kind both phases of a gate run are recorded under. */
export const QUALITY_GATE_EVENT_KIND = "quality_gate";

/** The most output a finished event keeps: the tail a fixer needs, not the log. */
export const QUALITY_GATE_LOG_TAIL_BYTES = 6_000;

/** What warren recorded about one gate run in a run's sandbox. */
export interface QualityGateResult {
	/** The command warren ran (`.warren/config.yaml` `qualityGate`). */
	readonly command: string;
	/** Exit status; `null` when the command never produced one (spawn error, kill). */
	readonly exitCode: number | null;
	/** True when warren killed the command at its time limit. */
	readonly timedOut: boolean;
	readonly durationMs: number;
	/** `git rev-parse HEAD` in the sandbox just before the command ran; null if unreadable. */
	readonly sha: string | null;
	/** The last {@link QUALITY_GATE_LOG_TAIL_BYTES} of combined stdout and stderr. */
	readonly logTail: string;
	/** Set when warren could not start the command at all. */
	readonly error?: string;
}

/** The finished-event payload: the result plus its discriminators. */
export type QualityGateFinishedPayload = QualityGateResult & {
	readonly type: "quality_gate";
	readonly phase: "finished";
};

/** Green only on a real exit 0; a timeout or spawn error is never green. */
export function isQualityGateGreen(result: QualityGateResult): boolean {
	return result.exitCode === 0 && !result.timedOut && result.error === undefined;
}

/** True when the gate produced a verdict on the code (green or red), not a warren fault. */
export function qualityGateRan(result: QualityGateResult): boolean {
	return result.error === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a finished-event payload back, or null for anything else (the started phase included). */
export function readQualityGateResult(payload: unknown): QualityGateResult | null {
	if (!isRecord(payload)) return null;
	if (payload.type !== "quality_gate" || payload.phase !== "finished") return null;
	const { command, exitCode, timedOut, durationMs, sha, logTail, error } = payload;
	if (typeof command !== "string" || typeof durationMs !== "number") return null;
	if (exitCode !== null && typeof exitCode !== "number") return null;
	return {
		command,
		exitCode,
		timedOut: timedOut === true,
		durationMs,
		sha: typeof sha === "string" && sha.length > 0 ? sha : null,
		logTail: typeof logTail === "string" ? logTail : "",
		...(typeof error === "string" ? { error } : {}),
	};
}
