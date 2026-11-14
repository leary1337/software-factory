import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { projectsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import type {
	ExecutionOption,
	ExecutionProfile,
	ExecutionProfiles,
} from "../../../core/execution-profiles.ts";
import type { TaskBudgetLimits } from "../../../core/plan-approval.ts";
import type { PreparationRecipe } from "../../../core/preparation.ts";
import type { ProjectSettingsResponse } from "../../../core/project-settings.ts";
import type { ProjectDeploymentSettings } from "../../../core/release.ts";
import type { ProjectMergeSettings } from "../../../core/wire-merge.ts";
import { ProjectBudgetSettings } from "./project-budget-settings.tsx";
import { ProjectMergeSettingsFields } from "./project-merge-settings.tsx";
import { ProjectReleaseSettings } from "./project-release-settings.tsx";
import { PreparationFields } from "./project-settings-preparation.tsx";

export function ProjectSettingsPanel(props: { projectId: string }) {
	return (
		<OperatorOnly capability="admin">
			<ProjectSettingsContent {...props} />
		</OperatorOnly>
	);
}

function ProjectSettingsContent({ projectId }: { projectId: string }) {
	const query = useQuery({
		queryKey: ["projects", projectId, "settings"],
		queryFn: ({ signal }) => projectsApi.settings(projectId, signal),
	});
	const [saved, setSaved] = useState(false);
	return (
		<section
			aria-label="Project settings"
			className="space-y-4 border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Execution settings</h2>
			<p className="text-(--color-text-2) text-sm">
				Choose who implements and reviews new work. Rework uses the executor. Started plans keep
				their approved choices.
			</p>
			{query.isPending ? (
				<Spinner label="Loading execution settings" />
			) : query.isError ? (
				<Alert variant="danger" title="Could not load execution settings">
					{formatError(query.error)}{" "}
					<Button variant="outline" onClick={() => void query.refetch()}>
						Retry settings
					</Button>
				</Alert>
			) : (
				<>
					{query.data.errors.length > 0 ? (
						<Alert variant="warning" title="Project configuration needs attention">
							{query.data.errors.map((error) => error.message).join("; ")}
						</Alert>
					) : null}
					{saved ? (
						<Alert title="Project settings saved">New work will use these settings.</Alert>
					) : null}
					<SettingsForm
						key={`${projectId}:${query.data.revision}`}
						projectId={projectId}
						data={query.data}
						onSaved={() => setSaved(true)}
						onEdit={() => setSaved(false)}
					/>
				</>
			)}
		</section>
	);
}

function ProfileFields({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: ExecutionProfile;
	options: ExecutionOption[];
	onChange: (profile: ExecutionProfile) => void;
}) {
	const id = useId();
	return (
		<fieldset className="min-w-0 space-y-3 rounded-md border border-(--color-border) p-3">
			<legend className="px-1 font-medium text-sm">{label}</legend>
			<label htmlFor={`${id}-cli`} className="block space-y-1 text-sm">
				<span>{label} CLI</span>
				<SelectInput
					id={`${id}-cli`}
					className="h-11 w-full text-base sm:h-9 sm:text-sm"
					value={value.runtime}
					onChange={(event) => {
						const selected = options.find((option) => option.runtime === event.target.value);
						if (selected) onChange({ runtime: selected.runtime, model: selected.defaultModel });
					}}
				>
					{options.map((option) => (
						<option key={option.runtime} value={option.runtime}>
							{option.label}
						</option>
					))}
				</SelectInput>
			</label>
			<label htmlFor={`${id}-model`} className="block space-y-1 text-sm">
				<span>{label} model</span>
				<Input
					id={`${id}-model`}
					className="h-11 text-base sm:h-9 sm:text-sm"
					value={value.model}
					required
					maxLength={200}
					onChange={(event) => onChange({ ...value, model: event.target.value })}
				/>
			</label>
		</fieldset>
	);
}

function SettingsForm({
	projectId,
	data,
	onSaved,
	onEdit,
}: {
	projectId: string;
	data: ProjectSettingsResponse;
	onSaved: () => void;
	onEdit: () => void;
}) {
	const qc = useQueryClient();
	const memoryId = useId();
	const [qualityGate, setQualityGate] = useState(data.effective.qualityGate ?? "");
	const [profiles, setProfiles] = useState<ExecutionProfiles>(data.effective.executionProfiles);
	const [preparation, setPreparation] = useState<PreparationRecipe>(
		data.effective.preparation ?? { recipe: "auto" },
	);
	const [merge, setMerge] = useState<ProjectMergeSettings>(data.effective.pr ?? {});
	const [deploy, setDeploy] = useState<ProjectDeploymentSettings>(data.effective.deploy ?? {});
	const [budgets, setBudgets] = useState<Partial<TaskBudgetLimits>>(
		data.effective.taskBudgets ?? {},
	);
	const [memoryEnabled, setMemoryEnabled] = useState(data.effective.memoryEnabled === true);
	const save = useMutation({
		mutationFn: () =>
			projectsApi.updateSettings(projectId, {
				revision: data.revision,
				patch: {
					executionProfiles: profiles,
					qualityGate: qualityGate.trim() || undefined,
					pr: merge,
					preparation,
					memoryEnabled,
					deploy,
					taskBudgets: budgets,
				},
			}),
		onSuccess: (response) => {
			qc.setQueryData(["projects", projectId, "settings"], response);
			void qc.invalidateQueries({ queryKey: ["projects", projectId, "warren-config"] });
			void qc.invalidateQueries({ queryKey: ["project-readiness", projectId] });
			onSaved();
		},
	});
	return (
		<form
			className="space-y-4"
			onChange={onEdit}
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<ProfileFields
					label="Executor"
					value={profiles.implementation}
					options={data.executionOptions}
					onChange={(implementation) => setProfiles({ ...profiles, implementation })}
				/>
				<ProfileFields
					label="Reviewer"
					value={profiles.review}
					options={data.executionOptions}
					onChange={(review) => setProfiles({ ...profiles, review })}
				/>
			</div>
			<p className="text-(--color-text-2) text-sm">
				Model names are sent unchanged. Independent review remains required.
			</p>
			<PreparationFields value={preparation} onChange={setPreparation} />
			<label htmlFor={`${memoryId}-gate`} className="block space-y-1 text-sm">
				<span>Project verification command</span>
				<Input
					id={`${memoryId}-gate`}
					value={qualityGate}
					onChange={(event) => setQualityGate(event.target.value)}
				/>
				<span className="text-(--color-text-2) text-xs">
					Runs in the prepared checkout before review can pass.
				</span>
			</label>
			<ProjectMergeSettingsFields value={merge} onChange={setMerge} />
			<ProjectBudgetSettings value={budgets} onChange={setBudgets} />
			<ProjectReleaseSettings value={deploy} onChange={setDeploy} />
			<label htmlFor={memoryId} className="block space-y-1 text-sm">
				<span>Project memory</span>
				<SelectInput
					id={memoryId}
					className="h-11 w-full text-base sm:h-9 sm:text-sm"
					value={memoryEnabled ? "enabled" : "disabled"}
					onChange={(event) => setMemoryEnabled(event.target.value === "enabled")}
				>
					<option value="disabled">Off</option>
					<option value="enabled">Use existing project memory</option>
				</SelectInput>
			</label>
			{save.isError ? (
				<Alert variant="danger" title="Settings were not saved">
					{formatError(save.error)}{" "}
					<Button
						variant="outline"
						type="button"
						onClick={() =>
							void qc.invalidateQueries({ queryKey: ["projects", projectId, "settings"] })
						}
					>
						Reload settings
					</Button>
				</Alert>
			) : null}
			<Button
				type="submit"
				className="w-full sm:w-auto"
				disabled={
					save.isPending || !profiles.implementation.model.trim() || !profiles.review.model.trim()
				}
			>
				{save.isPending ? "Saving settings…" : "Save project settings"}
			</Button>
		</form>
	);
}
