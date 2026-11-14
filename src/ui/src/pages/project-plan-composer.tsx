import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { approvalsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { PlanPermission, PreparePlanApproval } from "../../../core/plan-approval.ts";
import { ApprovalPreview } from "./approval-preview.tsx";
import { TaskPermissionFields } from "./task-permission-fields.tsx";

export type TaskDraft = {
	permissions?: PlanPermission[];
	key: string;
	title: string;
	description: string;
	acceptance: string;
	dependencies: string;
	releaseAfter: boolean;
};
const emptyTask = (): TaskDraft => ({
	key: crypto.randomUUID(),
	title: "",
	description: "",
	acceptance: "",
	dependencies: "",
	releaseAfter: false,
});
export function ProjectPlanComposer(props: { projectId: string }) {
	return (
		<OperatorOnly capability="dispatch">
			<PlanComposerContent {...props} />
		</OperatorOnly>
	);
}

function PlanComposerContent({ projectId }: { projectId: string }) {
	const [params, setParams] = useSearchParams();
	const approvalId = params.get("approval");
	const [open, setOpen] = useState(false);
	const saved = useQuery({
		queryKey: ["approval", approvalId],
		queryFn: ({ signal }) => approvalsApi.get(approvalId ?? "", signal),
		enabled: !!approvalId,
	});
	const clearApproval = () =>
		setParams((next) => {
			next.delete("approval");
			return next;
		});
	return (
		<section
			aria-label="Prepare a plan"
			className="space-y-4 rounded-xl border border-(--color-border) bg-(--color-surface) p-4"
		>
			<Button variant="outline" onClick={() => setOpen(!open)}>
				{open ? "Close plan editor" : "Prepare a plan"}
			</Button>
			{approvalId ? (
				saved.isPending ? (
					<Spinner label="Loading saved plan" />
				) : saved.isError ? (
					<Alert variant="danger" title="Could not load saved plan">
						{formatError(saved.error)}
						<Button variant="outline" onClick={() => void saved.refetch()}>
							Retry
						</Button>
					</Alert>
				) : saved.data.approval.snapshot.projectId !== projectId ? (
					<Alert variant="danger" title="This saved plan belongs to another project" />
				) : (
					<ApprovalPreview
						approval={saved.data.approval}
						onBack={() => {
							clearApproval();
							setOpen(true);
						}}
					/>
				)
			) : open ? (
				<PlanDraftForm
					projectId={projectId}
					onPrepared={(id) =>
						setParams((next) => {
							next.set("approval", id);
							return next;
						})
					}
				/>
			) : null}
		</section>
	);
}
function PlanDraftForm({
	projectId,
	onPrepared,
}: {
	projectId: string;
	onPrepared: (id: string) => void;
}) {
	const id = useId();
	const [title, setTitle] = useState("");
	const [tasks, setTasks] = useState<TaskDraft[]>([emptyTask()]);
	const [commandKey, setCommandKey] = useState(() => crypto.randomUUID());
	const edit = () => setCommandKey(crypto.randomUUID());
	const prepare = useMutation({
		mutationFn: () => {
			const input: PreparePlanApproval = {
				commandKey,
				projectId,
				title,
				tasks: tasks.map((task) => ({
					title: task.title,
					description: task.description,
					acceptance: task.acceptance
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean),
					dependsOn: task.dependencies
						.split(/[,\s]+/)
						.filter(Boolean)
						.map(Number),
					releaseAfter: task.releaseAfter,
					permissions: task.permissions,
				})),
			};
			return approvalsApi.prepare(input);
		},
		onSuccess: (data) => onPrepared(data.approval.id),
	});
	return (
		<form
			className="space-y-4"
			onChange={edit}
			onSubmit={(event) => {
				event.preventDefault();
				prepare.mutate();
			}}
		>
			<label htmlFor={`${id}-title`} className="block space-y-1 text-sm">
				<span>Plan title</span>
				<Input
					id={`${id}-title`}
					required
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</label>
			{tasks.map((task, index) => (
				<TaskDraftFields
					key={task.key}
					id={`${id}-${task.key}`}
					index={index}
					task={task}
					onChange={(next) => setTasks(tasks.map((row) => (row.key === task.key ? next : row)))}
				/>
			))}
			<Button
				type="button"
				variant="outline"
				onClick={() => {
					setTasks([...tasks, emptyTask()]);
					edit();
				}}
			>
				Add task
			</Button>
			<p className="text-(--color-text-2) text-sm">
				Ordinary changes proceed automatically. Additional access, destructive migrations and
				factory rule changes need an explicit decision.
			</p>
			{prepare.isError ? (
				<Alert variant="danger" title="Plan was not prepared">
					{formatError(prepare.error)}
				</Alert>
			) : null}
			<div>
				<Button type="submit" disabled={prepare.isPending}>
					{prepare.isPending ? "Saving preview…" : "Save plan for approval"}
				</Button>
			</div>
		</form>
	);
}
export function TaskDraftFields({
	id,
	index,
	task,
	onChange,
}: {
	id: string;
	index: number;
	task: TaskDraft;
	onChange: (task: TaskDraft) => void;
}) {
	return (
		<fieldset className="space-y-3 rounded-md border border-(--color-border) p-3">
			<legend className="px-1 font-medium text-sm">Task {index + 1}</legend>
			<label htmlFor={`${id}-title`} className="block space-y-1 text-sm">
				<span>Task title</span>
				<Input
					id={`${id}-title`}
					required
					value={task.title}
					onChange={(event) => onChange({ ...task, title: event.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-description`} className="block space-y-1 text-sm">
				<span>Task description</span>
				<Textarea
					id={`${id}-description`}
					required
					value={task.description}
					onChange={(event) => onChange({ ...task, description: event.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-acceptance`} className="block space-y-1 text-sm">
				<span>Acceptance criteria (one per line)</span>
				<Textarea
					id={`${id}-acceptance`}
					required
					value={task.acceptance}
					onChange={(event) => onChange({ ...task, acceptance: event.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-dependencies`} className="block space-y-1 text-sm">
				<span>Depends on task numbers</span>
				<Input
					id={`${id}-dependencies`}
					value={task.dependencies}
					onChange={(event) => onChange({ ...task, dependencies: event.target.value })}
				/>
			</label>
			<label htmlFor={`${id}-release`} className="block space-y-1 text-sm">
				<span>Release boundary</span>
				<SelectInput
					id={`${id}-release`}
					value={task.releaseAfter ? "stage" : "plan"}
					onChange={(event) => onChange({ ...task, releaseAfter: event.target.value === "stage" })}
				>
					<option value="plan">After the whole plan</option>
					<option value="stage">After this approved stage</option>
				</SelectInput>
			</label>
			<TaskPermissionFields
				value={task.permissions ?? []}
				onChange={(permissions) => onChange({ ...task, permissions })}
			/>
		</fieldset>
	);
}
