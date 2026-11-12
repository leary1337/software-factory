import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3, LayoutDashboard, LogIn, LogOut, Rocket, Settings } from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { metaApi, setApiToken } from "@/api/client.ts";
import {
	ALL_NAV_SECTIONS,
	type ConsoleNavItem,
	DOCUMENTATION_URL,
	INSTANCE_NAV_ITEM,
	SETUP_NAV_ITEM,
} from "@/components/console/console-nav.ts";
import type { ConsoleStats } from "@/components/console/use-console-stats.ts";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { Button } from "@/components/ui/button.tsx";
import { WarrenLogo } from "@/components/warren-logo.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkspaceLink } from "@/pages/workspace/project-scope.tsx";

function NavRow({ item, onNavigate }: { item: ConsoleNavItem; onNavigate?: () => void }) {
	const scopedLink = useWorkspaceLink();
	const Icon = {
		"/overview": LayoutDashboard,
		"/kanban": Columns3,
		"/production": Rocket,
		"/instance": Settings,
	}[item.to];
	return (
		<NavLink
			to={scopedLink(item.to)}
			onClick={onNavigate}
			className={({ isActive }) =>
				cn(
					"flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm",
					isActive
						? "bg-(--color-primary)/10 font-medium text-(--color-primary)"
						: "text-(--color-text-2) hover:bg-(--color-surface-raised)",
				)
			}
		>
			{Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
			{item.label}
		</NavLink>
	);
}

function SidebarFooter({ onNavigate }: { onNavigate?: () => void }) {
	const caps = useCapabilities();
	const qc = useQueryClient();
	const navigate = useNavigate();
	return (
		<div className="space-y-2 border-(--color-border) border-t p-3">
			<NavRow item={INSTANCE_NAV_ITEM} onNavigate={onNavigate} />
			<a
				href={DOCUMENTATION_URL}
				target="_blank"
				rel="noreferrer"
				className="block px-3 py-2 text-(--color-text-3) text-sm"
			>
				Documentation ↗
			</a>
			<div className="flex flex-wrap items-center gap-2">
				{caps.can("readOperator") ? (
					<Button
						variant="ghost"
						className="text-(--color-text-3)"
						onClick={() => {
							setApiToken(null);
							qc.clear();
							navigate("/login", { replace: true });
						}}
					>
						<LogOut className="mr-2 h-4 w-4" />
						Log out
					</Button>
				) : (
					<Button variant="ghost" asChild>
						<Link to="/login">
							<LogIn className="mr-2 h-4 w-4" />
							Log in
						</Link>
					</Button>
				)}
				<ThemeToggle />
			</div>
		</div>
	);
}

export function ConsoleSidebarBody({
	stats,
	onNavigate,
}: {
	stats: ConsoleStats;
	onNavigate?: () => void;
}) {
	const caps = useCapabilities();
	const location = useLocation();
	const version = useQuery({
		queryKey: ["meta", "version"],
		queryFn: ({ signal }) => metaApi.version(signal),
		staleTime: Number.POSITIVE_INFINITY,
	});
	return (
		<>
			<div className="flex h-20 shrink-0 items-center gap-2 px-5">
				<Link
					to="/"
					aria-label="Warren home"
					onClick={onNavigate}
					className="flex items-center gap-2"
				>
					<WarrenLogo className="h-6 w-6" />
					<span className="font-semibold text-lg tracking-tight">warren</span>
				</Link>
				{version.data ? (
					<span data-visual-mask="" className="text-(--color-text-3) text-xs">
						v{version.data.version}
					</span>
				) : null}
			</div>
			<nav aria-label="Workspace" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3">
				{ALL_NAV_SECTIONS.map((section) => {
					const rows = section.items
						.filter((item) => item.capability === undefined || caps.can(item.capability))
						.map((item) => <NavRow key={item.to} item={item} onNavigate={onNavigate} />);
					return section.heading === "More" ? (
						<details
							key={section.heading}
							open={
								section.items.some((item) => location.pathname.startsWith(item.to)) || undefined
							}
							className="pt-5"
						>
							<summary className="cursor-pointer px-3 py-3 text-(--color-text-3) text-sm">
								More
							</summary>
							{rows}
						</details>
					) : (
						<div key={section.heading} className="space-y-1">
							{rows}
						</div>
					);
				})}
				{caps.can("admin") && stats.runsTotal === 0 ? (
					<NavRow item={SETUP_NAV_ITEM} onNavigate={onNavigate} />
				) : null}
			</nav>
			<SidebarFooter onNavigate={onNavigate} />
		</>
	);
}

export function ConsoleSidebar({ stats }: { stats: ConsoleStats }) {
	return (
		<aside className="hidden w-56 shrink-0 flex-col border-(--color-border) border-r bg-(--color-sidebar) md:flex">
			<ConsoleSidebarBody stats={stats} />
		</aside>
	);
}
