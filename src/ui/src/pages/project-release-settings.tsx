import { useId } from "react";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import type { ProjectDeploymentSettings, RollbackPolicy } from "../../../core/release.ts";

export function ProjectReleaseSettings({
	value,
	onChange,
}: {
	value: ProjectDeploymentSettings;
	onChange: (value: ProjectDeploymentSettings) => void;
}) {
	const id = useId();
	const textField = (key: string, label: string, text: string, update: (text: string) => void) => (
		<label htmlFor={`${id}-${key}`} className="block space-y-1 text-sm">
			<span>{label}</span>
			<Input
				id={`${id}-${key}`}
				value={text}
				className="h-11 text-base sm:h-9 sm:text-sm"
				onChange={(event) => update(event.target.value)}
			/>
		</label>
	);
	return (
		<details className="space-y-3 rounded-md border border-(--color-border) p-3">
			<summary className="cursor-pointer font-medium text-sm">
				Release verification and rollback
			</summary>
			<p className="text-(--color-text-2) text-sm">
				These settings apply to the project's application. The factory stays on this device.
			</p>
			<label htmlFor={`${id}-auto`} className="block space-y-1 text-sm">
				<span>Release approved plans</span>
				<SelectInput
					id={`${id}-auto`}
					value={value.autoDeploy ? "enabled" : "disabled"}
					onChange={(event) => onChange({ ...value, autoDeploy: event.target.value === "enabled" })}
				>
					<option value="disabled">Manual release</option>
					<option value="enabled">Release after the plan or an approved stage</option>
				</SelectInput>
			</label>
			{textField("workflow", "Release workflow", value.workflow ?? "", (workflow) =>
				onChange({ ...value, workflow: workflow || undefined }),
			)}
			{textField("environment", "Release environment", value.environment ?? "", (environment) =>
				onChange({ ...value, environment: environment || undefined }),
			)}
			<label htmlFor={`${id}-verification`} className="block space-y-1 text-sm">
				<span>Verify the published application</span>
				<SelectInput
					id={`${id}-verification`}
					value={value.verification ? "enabled" : "disabled"}
					onChange={(event) =>
						onChange({
							...value,
							verification:
								event.target.value === "enabled"
									? { versionUrl: "", scenarioUrl: "", expectedText: "" }
									: undefined,
						})
					}
				>
					<option value="disabled">Not configured</option>
					<option value="enabled">Check version and user scenario</option>
				</SelectInput>
			</label>
			{value.verification ? (
				<label htmlFor={`${id}-artifact`} className="block space-y-1 text-sm">
					<span>Проверять через workflow</span>
					<Input
						id={`${id}-artifact`}
						type="checkbox"
						className="h-4 w-4"
						checked={!!value.verification.artifactName}
						onChange={(event) => {
							if (value.verification)
								onChange({
									...value,
									verification: {
										...value.verification,
										artifactName: event.target.checked ? "factory-verification" : undefined,
									},
								});
						}}
					/>
				</label>
			) : null}
			{value.verification ? (
				<div className="space-y-3">
					{textField(
						"version-url",
						"Published version URL",
						value.verification.versionUrl,
						(versionUrl) => {
							if (value.verification)
								onChange({ ...value, verification: { ...value.verification, versionUrl } });
						},
					)}
					{textField(
						"sha-field",
						"Version JSON field (leave empty for plain SHA)",
						value.verification.shaField ?? "",
						(shaField) => {
							if (value.verification)
								onChange({
									...value,
									verification: { ...value.verification, shaField: shaField || undefined },
								});
						},
					)}
					{textField(
						"scenario-url",
						"Read-only user scenario URL",
						value.verification.scenarioUrl,
						(scenarioUrl) => {
							if (value.verification)
								onChange({ ...value, verification: { ...value.verification, scenarioUrl } });
						},
					)}
					{textField(
						"expected-text",
						"Expected scenario response text",
						value.verification.expectedText,
						(expectedText) => {
							if (value.verification)
								onChange({ ...value, verification: { ...value.verification, expectedText } });
						},
					)}
				</div>
			) : null}
			<label htmlFor={`${id}-rollback`} className="block space-y-1 text-sm">
				<span>Rollback policy</span>
				<SelectInput
					id={`${id}-rollback`}
					value={value.rollback ? "enabled" : "disabled"}
					onChange={(event) =>
						onChange({
							...value,
							rollback:
								event.target.value === "enabled"
									? { workflow: "", shaInput: "sha", compatibility: "unknown", reason: "" }
									: undefined,
						})
					}
				>
					<option value="disabled">Not configured</option>
					<option value="enabled">Configure application rollback</option>
				</SelectInput>
			</label>
			{value.rollback ? (
				<div className="space-y-3">
					{textField(
						"rollback-workflow",
						"Rollback workflow",
						value.rollback.workflow,
						(workflow) => {
							if (value.rollback) onChange({ ...value, rollback: { ...value.rollback, workflow } });
						},
					)}
					{textField(
						"rollback-input",
						"Rollback SHA input",
						value.rollback.shaInput,
						(shaInput) => {
							if (value.rollback) onChange({ ...value, rollback: { ...value.rollback, shaInput } });
						},
					)}
					<label htmlFor={`${id}-compatibility`} className="block space-y-1 text-sm">
						<span>Data compatibility</span>
						<SelectInput
							id={`${id}-compatibility`}
							value={value.rollback.compatibility}
							onChange={(event) => {
								if (value.rollback)
									onChange({
										...value,
										rollback: {
											...value.rollback,
											compatibility: event.target.value as RollbackPolicy["compatibility"],
										},
									});
							}}
						>
							<option value="unknown">Unknown — ask for a decision</option>
							<option value="application-only">Application rollback leaves data compatible</option>
							<option value="requires-data-change">
								Data change required — ask for a decision
							</option>
						</SelectInput>
					</label>
					{textField(
						"rollback-reason",
						"Compatibility evidence",
						value.rollback.reason,
						(reason) => {
							if (value.rollback) onChange({ ...value, rollback: { ...value.rollback, reason } });
						},
					)}
				</div>
			) : null}
		</details>
	);
}
