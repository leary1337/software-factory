/** Explicit local rollout switch. Unset installations retain their sandbox behavior. */
export type LocalExecutionMode = "sandbox" | "process";

export function resolveLocalExecutionMode(
	env: Readonly<Record<string, string | undefined>> = process.env,
	platform: NodeJS.Platform = process.platform,
): LocalExecutionMode {
	const mode = env.WARREN_LOCAL_EXECUTION?.trim() || "sandbox";
	if (mode !== "sandbox" && mode !== "process")
		throw new Error(`Unknown WARREN_LOCAL_EXECUTION '${mode}'; use sandbox or process`);
	if (mode === "process" && platform !== "darwin")
		throw new Error("WARREN_LOCAL_EXECUTION=process currently requires macOS");
	return mode;
}
