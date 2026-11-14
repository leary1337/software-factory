import { useId } from "react";
import { Input } from "@/components/ui/input.tsx";
import type { TaskBudgetLimits } from "../../../core/plan-approval.ts";

const FIELDS: { key: keyof TaskBudgetLimits; label: string; scale: number }[] = [
	{ key: "repairs", label: "Repair attempts", scale: 1 },
	{ key: "reworks", label: "Review rework attempts", scale: 1 },
	{ key: "runMs", label: "Maximum execution minutes", scale: 60_000 },
	{ key: "activeMs", label: "Total active minutes per task", scale: 60_000 },
	{ key: "externalWaitMs", label: "External wait minutes", scale: 60_000 },
];
export function ProjectBudgetSettings({
	value,
	onChange,
}: {
	value: Partial<TaskBudgetLimits>;
	onChange: (value: Partial<TaskBudgetLimits>) => void;
}) {
	const id = useId();
	return (
		<details className="space-y-3 rounded-md border border-(--color-border) p-3">
			<summary className="cursor-pointer font-medium text-sm">Task limits</summary>
			<p className="text-(--color-text-2) text-sm">
				Empty fields use factory defaults. The approval preview fixes exact limits before work
				starts.
			</p>
			<div className="grid gap-3 sm:grid-cols-2">
				{FIELDS.map(({ key, label, scale }) => (
					<label key={key} htmlFor={`${id}-${key}`} className="block space-y-1 text-sm">
						<span>{label}</span>
						<Input
							id={`${id}-${key}`}
							type="number"
							min={key === "repairs" || key === "reworks" ? 0 : 1}
							step="1"
							value={value[key] === undefined ? "" : value[key] / scale}
							onChange={(event) => {
								const next = { ...value };
								if (!event.target.value) delete next[key];
								else next[key] = Number(event.target.value) * scale;
								onChange(next);
							}}
						/>
					</label>
				))}
			</div>
		</details>
	);
}
