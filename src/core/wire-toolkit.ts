export const TOOL_AVAILABILITIES = ["available", "quota", "unavailable"] as const;
export type ToolAvailability = (typeof TOOL_AVAILABILITIES)[number];
export const FREE_REMOTE_NAMES = ["exa", "context7"] as const;
export type FreeRemoteName = (typeof FREE_REMOTE_NAMES)[number];
export interface ToolProbe {
	service: FreeRemoteName;
	status: ToolAvailability;
	tools: readonly string[];
}
export interface ToolkitVersionInfo {
	version: string;
	skillsVersion: string;
	createdAt: string;
}
export interface ToolkitStatus {
	activeVersion: string;
	versions: readonly ToolkitVersionInfo[];
}
export interface ToolkitCheck {
	dependencies: readonly ToolkitDependencyCheck[];
	candidate: ToolkitVersionInfo;
	probes: readonly ToolProbe[];
}

export interface ToolkitDependencyCheck {
	name: string;
	available: boolean;
}
