import type { CapabilityName } from "@/api/types.ts";

export interface ConsoleNavItem {
	readonly index: string;
	readonly label: string;
	readonly to: string;
	readonly capability?: CapabilityName;
}

export const WORKLOADS_NAV: readonly ConsoleNavItem[] = [
	{ index: "01", label: "Overview", to: "/overview" },
	{ index: "02", label: "Kanban", to: "/kanban" },
	{ index: "03", label: "Production", to: "/production", capability: "readOperator" },
];
export const INFRASTRUCTURE_NAV: readonly ConsoleNavItem[] = [
	{ index: "04", label: "Plans", to: "/plan-runs" },
	{ index: "05", label: "Projects", to: "/projects" },
	{ index: "06", label: "Runs", to: "/runs" },
	{ index: "07", label: "Operations", to: "/operations" },
	{ index: "08", label: "Agents", to: "/agents" },
	{ index: "09", label: "Telemetry", to: "/telemetry" },
	{ index: "10", label: "Events", to: "/events" },
];
export const INSTANCE_NAV_ITEM: ConsoleNavItem = {
	index: "05",
	label: "Settings",
	to: "/instance",
};
export const SETUP_NAV_ITEM: ConsoleNavItem = {
	index: "00",
	label: "Setup",
	to: "/setup",
	capability: "admin",
};
export const MOBILE_BOTTOM_NAV_ITEMS = WORKLOADS_NAV;
export const ALL_NAV_SECTIONS = [
	{ heading: "FACTORY", items: WORKLOADS_NAV },
	{ heading: "More", items: INFRASTRUCTURE_NAV },
] as const;
