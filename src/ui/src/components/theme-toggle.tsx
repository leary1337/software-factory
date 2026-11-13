import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { type Theme, useTheme } from "@/hooks/use-theme.ts";
import { cn } from "@/lib/utils.ts";

const NEXT: Record<Theme, Theme> = {
	light: "dark",
	dark: "system",
	system: "light",
};

const LABEL: Record<Theme, string> = {
	light: "Light",
	dark: "Dark",
	system: "System",
};

export function ThemeToggle({ className }: { className?: string }): React.JSX.Element {
	const { theme, setTheme } = useTheme();
	const next = NEXT[theme];
	const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
	const ariaLabel = `Theme: ${LABEL[theme].toLowerCase()}. Click to switch to ${LABEL[next].toLowerCase()}.`;

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={() => setTheme(next)}
			className={cn("justify-start", className)}
			aria-label={ariaLabel}
			title={ariaLabel}
		>
			<Icon className="h-4 w-4 shrink-0" aria-hidden />
			<span>{LABEL[theme]}</span>
		</Button>
	);
}
