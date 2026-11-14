import { useId } from "react";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import type { PreparationRecipe, PreparationTool } from "../../../core/preparation.ts";
import { PREPARATION_RECIPE_KINDS, type PreparationToolName } from "../../../core/wire.ts";

const LABELS = {
	auto: "Detect the existing stack",
	command: "Custom command",
	javascript: "JavaScript / TypeScript",
	"python-uv": "Python with uv",
	go: "Go",
};
const TOOLS: Record<PreparationRecipe["recipe"], PreparationToolName[]> = {
	auto: [],
	command: [],
	javascript: ["node", "bun", "npm", "pnpm", "yarn"],
	"python-uv": ["python", "uv"],
	go: ["go"],
};

export function PreparationFields({
	value,
	onChange,
}: {
	value: PreparationRecipe;
	onChange: (value: PreparationRecipe) => void;
}) {
	const id = useId();
	const updateTool = (name: PreparationToolName, patch: PreparationTool) => {
		const tools = { ...value.tools };
		const tool = { ...tools[name], ...patch };
		if (!tool.version && !tool.executable) delete tools[name];
		else tools[name] = tool;
		onChange({ ...value, tools });
	};
	return (
		<fieldset className="min-w-0 space-y-3 rounded-md border border-(--color-border) p-3">
			<legend className="px-1 font-medium text-sm">Prepare the project</legend>
			<label htmlFor={`${id}-recipe`} className="block space-y-1 text-sm">
				<span>Preparation recipe</span>
				<SelectInput
					id={`${id}-recipe`}
					className="h-11 w-full text-base sm:h-9 sm:text-sm"
					value={value.recipe}
					onChange={(event) => {
						const recipe = PREPARATION_RECIPE_KINDS.find((entry) => entry === event.target.value);
						if (recipe) onChange({ ...value, recipe });
					}}
				>
					{PREPARATION_RECIPE_KINDS.map((recipe) => (
						<option key={recipe} value={recipe}>
							{LABELS[recipe]}
						</option>
					))}
				</SelectInput>
			</label>
			{value.recipe === "command" ? (
				<label htmlFor={`${id}-command`} className="block space-y-1 text-sm">
					<span>Preparation command</span>
					<Input
						id={`${id}-command`}
						className="h-11 text-base sm:h-9 sm:text-sm"
						required
						value={value.command ?? ""}
						onChange={(event) => onChange({ ...value, command: event.target.value })}
					/>
				</label>
			) : null}
			<p className="text-(--color-text-2) text-sm">
				Preparation follows the repository lockfile and keeps its existing stack.
			</p>
			<details className="space-y-3">
				<summary className="cursor-pointer text-sm">Tool versions and time limit</summary>
				<label htmlFor={`${id}-timeout`} className="block space-y-1 text-sm">
					<span>Preparation timeout (seconds)</span>
					<Input
						id={`${id}-timeout`}
						className="h-11 text-base sm:h-9 sm:text-sm"
						type="number"
						min={1}
						max={3600}
						value={(value.timeoutMs ?? 600000) / 1000}
						onChange={(event) =>
							onChange({ ...value, timeoutMs: Number(event.target.value) * 1000 })
						}
					/>
				</label>
				{TOOLS[value.recipe].map((name) => (
					<div key={name} className="grid gap-2 sm:grid-cols-2">
						<label htmlFor={`${id}-${name}-version`} className="block space-y-1 text-sm">
							<span>{name} version (optional)</span>
							<Input
								id={`${id}-${name}-version`}
								className="h-11 text-base sm:h-9 sm:text-sm"
								value={value.tools?.[name]?.version ?? ""}
								onChange={(event) => updateTool(name, { version: event.target.value || undefined })}
							/>
						</label>
						<label htmlFor={`${id}-${name}-path`} className="block space-y-1 text-sm">
							<span>{name} executable path (optional)</span>
							<Input
								id={`${id}-${name}-path`}
								className="h-11 text-base sm:h-9 sm:text-sm"
								value={value.tools?.[name]?.executable ?? ""}
								onChange={(event) =>
									updateTool(name, { executable: event.target.value || undefined })
								}
							/>
						</label>
					</div>
				))}
			</details>
		</fieldset>
	);
}
