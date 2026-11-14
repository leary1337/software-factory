import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { PLAN_PERMISSION_KINDS, type PlanPermission } from "../../../core/plan-approval.ts";

const LABELS = {
	access: "Access changes",
	destructive_migration: "Destructive migration",
	factory_rules: "Factory rules",
};
export function TaskPermissionFields({
	value,
	onChange,
}: {
	value: PlanPermission[];
	onChange: (value: PlanPermission[]) => void;
}) {
	const available = PLAN_PERMISSION_KINDS.filter(
		(kind) => !value.some((permission) => permission.kind === kind),
	);
	return (
		<details className="space-y-3">
			<summary className="cursor-pointer text-sm">Explicit permissions ({value.length})</summary>
			<p className="text-(--color-text-2) text-sm">
				Authorize only the specific paths and change described here.
			</p>
			{value.map((permission, index) => (
				<fieldset key={permission.kind} className="space-y-2 border border-(--color-border) p-3">
					<legend className="px-1 text-sm">Permission {index + 1}</legend>
					<SelectInput
						aria-label={`Permission ${index + 1} kind`}
						value={permission.kind}
						onChange={(event) => {
							const kind = PLAN_PERMISSION_KINDS.find((kind) => kind === event.target.value);
							if (kind) onChange(value.map((row, i) => (i === index ? { ...row, kind } : row)));
						}}
					>
						{PLAN_PERMISSION_KINDS.filter(
							(kind) => kind === permission.kind || available.includes(kind),
						).map((kind) => (
							<option key={kind} value={kind}>
								{LABELS[kind]}
							</option>
						))}
					</SelectInput>
					<Input
						aria-label={`Permission ${index + 1} paths`}
						required
						value={permission.paths.join(", ")}
						onChange={(event) =>
							onChange(
								value.map((row, i) =>
									i === index
										? { ...row, paths: event.target.value.split(",").map((path) => path.trim()) }
										: row,
								),
							)
						}
					/>
					<Input
						aria-label={`Permission ${index + 1} reason`}
						required
						value={permission.reason}
						onChange={(event) =>
							onChange(
								value.map((row, i) => (i === index ? { ...row, reason: event.target.value } : row)),
							)
						}
					/>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onChange(value.filter((_, i) => i !== index))}
					>
						Remove permission
					</Button>
				</fieldset>
			))}
			<Button
				variant="outline"
				type="button"
				size="sm"
				disabled={available.length === 0}
				onClick={() => {
					if (available[0]) onChange([...value, { kind: available[0], paths: [], reason: "" }]);
				}}
			>
				Add explicit permission
			</Button>
		</details>
	);
}
