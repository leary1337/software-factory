import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export const Textarea = forwardRef<
	HTMLTextAreaElement,
	TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
	<textarea
		ref={ref}
		className={cn(
			"min-h-24 w-full rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-(--color-ring) focus-visible:ring-2 disabled:opacity-50 md:text-sm",
			className,
		)}
		{...props}
	/>
));
Textarea.displayName = "Textarea";
