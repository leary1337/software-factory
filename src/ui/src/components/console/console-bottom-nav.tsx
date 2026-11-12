import { Ellipsis } from "lucide-react";
import { NavLink } from "react-router-dom";
import { MOBILE_BOTTOM_NAV_ITEMS } from "@/components/console/console-nav.ts";
import { Button } from "@/components/ui/button.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";
import { useWorkspaceLink } from "@/pages/workspace/project-scope.tsx";

export function ConsoleBottomNav({ onOpenMore }: { readonly onOpenMore: () => void }) {
	const caps = useCapabilities();
	const scopedLink = useWorkspaceLink();
	return (
		<nav
			aria-label="Primary"
			className="flex min-h-14 shrink-0 border-(--color-border) border-t bg-(--color-sidebar) md:hidden"
		>
			{MOBILE_BOTTOM_NAV_ITEMS.filter((item) => !item.capability || caps.can(item.capability)).map(
				(item) => (
					<NavLink
						key={item.to}
						to={scopedLink(item.to)}
						className={({ isActive }) =>
							cn(
								"flex min-h-14 min-w-0 flex-1 items-center justify-center border-t-2 px-1 text-xs",
								isActive
									? "border-(--color-primary) font-medium text-(--color-primary)"
									: "border-transparent text-(--color-text-2)",
							)
						}
					>
						{item.label}
					</NavLink>
				),
			)}
			<Button
				variant="ghost"
				onClick={onOpenMore}
				className="h-auto flex-1 flex-col gap-1 rounded-none text-xs"
			>
				<Ellipsis className="h-4 w-4" />
				More
			</Button>
		</nav>
	);
}
