/** The supported local runtime is a trusted host process on macOS. */
export function assertLocalProcessPlatform(
	env: Readonly<Record<string, string | undefined>> = process.env,
	platform: NodeJS.Platform = process.platform,
): void {
	if (env.WARREN_LOCAL_EXECUTION?.trim() && env.WARREN_LOCAL_EXECUTION.trim() !== "process")
		throw new Error("WARREN_LOCAL_EXECUTION sandbox mode was retired; remove the setting");
	if (platform !== "darwin") throw new Error("Local process execution currently requires macOS");
}
