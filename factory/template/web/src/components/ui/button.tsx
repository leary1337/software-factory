import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Button({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
