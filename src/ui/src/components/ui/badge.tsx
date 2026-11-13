import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils.ts";

const badgeVariants = cva(
	"inline-flex items-center rounded-full border px-2.5 py-0.5 font-semibold text-xs transition-colors",
	{
		variants: {
			variant: {
				default: "border-transparent bg-(--color-primary) text-(--color-primary-foreground)",
				secondary: "border-transparent bg-(--color-muted) text-(--color-fg)",
				destructive:
					"border-transparent bg-(--color-destructive) text-(--color-destructive-foreground)",
				outline: "text-(--color-fg)",
				running: "border-transparent bg-(--color-info-soft) text-(--color-info)",
				queued: "border-transparent bg-(--color-warning-soft) text-(--color-warning)",
				succeeded: "border-transparent bg-(--color-success-soft) text-(--color-success)",
				failed: "border-transparent bg-(--color-danger-soft) text-(--color-danger)",
				cancelled: "border-transparent bg-(--color-surface-raised) text-(--color-text-2)",
				drafting: "border-transparent bg-(--color-surface-raised) text-(--color-text-2)",
				ready: "border-transparent bg-(--color-warning-soft) text-(--color-warning)",
				active: "border-transparent bg-(--color-info-soft) text-(--color-info)",
				done: "border-transparent bg-(--color-success-soft) text-(--color-success)",
				archived: "border-transparent bg-(--color-surface-raised) text-(--color-text-2)",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLSpanElement>,
		VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
	return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
