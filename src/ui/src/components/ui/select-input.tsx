import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export const SelectInput = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
	({ className, ...props }, ref) => (
		<select
			ref={ref}
			className={cn(
				"h-9 max-w-full rounded-md border border-(--color-border) bg-(--color-surface) px-3 text-(--color-text) text-sm focus-visible:outline-none focus-visible:ring-(--color-ring) focus-visible:ring-2 disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	),
);
SelectInput.displayName = "SelectInput";
