import type { CapabilityName } from "@/api/types.ts";

export interface ConsoleNavItem {
	readonly index: string;
	readonly label: string;
	readonly to: string;
	readonly capability?: CapabilityName;
}

export const WORKLOADS_NAV: readonly ConsoleNavItem[] = [
	{ index: "01", label: "Tasks", to: "/tasks" },
	{ index: "02", label: "Projects", to: "/projects" },
	{ index: "03", label: "Settings", to: "/instance" },
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
export const ALL_NAV_SECTIONS = [{ heading: "FACTORY", items: WORKLOADS_NAV }] as const;
