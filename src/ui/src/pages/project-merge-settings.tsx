import { useId } from "react";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import {
	AUTO_MERGE_METHODS,
	MERGE_VERIFICATION_MODES,
	type ProjectMergeSettings,
} from "../../../core/wire-merge.ts";

export function ProjectMergeSettingsFields({
	value,
	onChange,
}: {
	value: ProjectMergeSettings;
	onChange: (value: ProjectMergeSettings) => void;
}) {
	const id = useId();
	const policy = value.autoMerge;
	return (
		<fieldset className="min-w-0 space-y-3 rounded-md border border-(--color-border) p-3">
			<legend className="px-1 font-medium text-sm">Merge policy</legend>
			<label htmlFor={`${id}-policy`} className="block space-y-1 text-sm">
				<span>Verify before merging</span>
				<SelectInput
					id={`${id}-policy`}
					value={policy ? (policy.verification ?? "forge") : "manual"}
					onChange={(event) => {
						const verification = MERGE_VERIFICATION_MODES.find(
							(mode) => mode === event.target.value,
						);
						onChange({
							...value,
							autoMerge: verification
								? {
										...policy,
										method: verification === "warren" ? "merge" : (policy?.method ?? "merge"),
										verification,
										requiredChecks: policy?.requiredChecks,
										protectedPaths: policy?.protectedPaths ?? [],
										reviewedPaths: verification === "warren" ? policy?.reviewedPaths : undefined,
									}
								: undefined,
						});
					}}
				>
					<option value="manual">Manual merge — automatic plans are not ready</option>
					<option value="forge">Strict GitHub branch protection</option>
					<option value="warren">Independent factory review and named checks</option>
				</SelectInput>
			</label>
			{policy ? (
				<>
					<label htmlFor={`${id}-method`} className="block space-y-1 text-sm">
						<span>Merge method</span>
						<SelectInput
							id={`${id}-method`}
							value={policy.method}
							disabled={policy.verification === "warren"}
							onChange={(event) => {
								const method = AUTO_MERGE_METHODS.find((method) => method === event.target.value);
								if (method) onChange({ ...value, autoMerge: { ...policy, method } });
							}}
						>
							{AUTO_MERGE_METHODS.map((method) => (
								<option key={method} value={method}>
									{method}
								</option>
							))}
						</SelectInput>
					</label>
					{policy.verification === "warren" ? (
						<label htmlFor={`${id}-checks`} className="block space-y-1 text-sm">
							<span>Required merge checks (one per line)</span>
							<Textarea
								id={`${id}-checks`}
								required
								value={policy.requiredChecks?.join("\n") ?? ""}
								onChange={(event) =>
									onChange({
										...value,
										autoMerge: { ...policy, requiredChecks: event.target.value.split("\n") },
									})
								}
							/>
							<span className="text-(--color-text-2) text-xs">
								Each named check must pass for the exact reviewed commit.
							</span>
						</label>
					) : (
						<p className="text-(--color-text-2) text-sm">
							Readiness checks verify repository permissions and enforced branch protection.
						</p>
					)}
					<p className="text-(--color-text-2) text-sm">
						Protected paths and explicit task permissions remain enforced.
					</p>
				</>
			) : null}
		</fieldset>
	);
}
