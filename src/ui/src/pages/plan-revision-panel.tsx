import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { approvalsApi } from "@/api/client.ts";
import type { PlanRunChildRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { PlanApproval } from "../../../core/plan-approval.ts";
import { ProjectBudgetSettings } from "./project-budget-settings.tsx";
import { type TaskDraft, TaskDraftFields } from "./project-plan-composer.tsx";

export function PlanRevisionPanel({
	planRunId,
	childRows,
	active,
}: {
	planRunId: string;
	childRows: PlanRunChildRow[];
	active: boolean;
}) {
	const history = useQuery({
		queryKey: ["plan-approval", planRunId],
		queryFn: ({ signal }) => approvalsApi.history(planRunId, signal),
	});
	const approval = history.data?.revisions[0];
	return (
		<details className="space-y-3 rounded-xl border border-(--color-border) p-4">
			<summary className="cursor-pointer font-medium text-sm">Approved plan and decisions</summary>
			{history.isPending ? (
				<p role="status">Loading approval history…</p>
			) : history.isError ? (
				<Alert variant="warning" title="Approval history unavailable">
					{formatError(history.error)}
					<Button variant="outline" onClick={() => void history.refetch()}>
						Retry
					</Button>
				</Alert>
			) : !approval ? (
				<p className="text-(--color-text-2) text-sm">
					This historical plan has no saved approval snapshot. Its execution history remains
					available.
				</p>
			) : (
				<>
					<p className="break-all text-sm">
						Revision {approval.revision} · tools {approval.snapshot.toolkitVersion}
					</p>
					<p className="text-sm">
						Executor {approval.snapshot.profiles.implementation.model} · reviewer{" "}
						{approval.snapshot.profiles.review.model}
					</p>
					<ul className="space-y-2 text-sm">
						{history.data?.revisions.map((revision) => (
							<li key={revision.id}>
								Revision {revision.revision}: {revision.decision}
							</li>
						))}
					</ul>
					{active ? (
						<OperatorOnly capability="dispatch">
							<RevisionForm
								key={approval.id}
								approval={approval}
								childRows={childRows}
								planRunId={planRunId}
							/>
						</OperatorOnly>
					) : null}
				</>
			)}
		</details>
	);
}
function RevisionForm({
	approval,
	childRows,
	planRunId,
}: {
	approval: PlanApproval;
	childRows: PlanRunChildRow[];
	planRunId: string;
}) {
	const id = useId();
	const cache = useQueryClient();
	const pending = new Set(
		childRows.filter((child) => child.state === "pending").map((child) => child.seq),
	);
	const original = approval.snapshot.tasks.filter((task) => pending.has(task.seq));
	const [tasks, setTasks] = useState<(TaskDraft & { seq: number })[]>(() =>
		original.map((task) => ({
			key: task.id,
			seq: task.seq,
			title: task.title,
			description: task.description,
			acceptance: task.acceptance.join("\n"),
			dependencies: task.dependsOn.join(", "),
			releaseAfter: task.releaseAfter,
			permissions: task.permissions,
		})),
	);
	const [profiles, setProfiles] = useState(approval.snapshot.profiles);
	const [budgets, setBudgets] = useState<Partial<typeof approval.snapshot.budgets>>(
		approval.snapshot.budgets,
	);
	const [decision, setDecision] = useState("");
	const [commandKey, setCommandKey] = useState(() => crypto.randomUUID());
	const save = useMutation({
		mutationFn: () =>
			approvalsApi.revise(planRunId, {
				commandKey,
				expectedRevision: approval.revision,
				decision,
				settings: { executionProfiles: profiles, taskBudgets: budgets },
				tasks: tasks.map((task) => ({
					seq: task.seq,
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
					permissions: task.permissions ?? [],
				})),
			}),
		onSuccess: () => {
			void cache.invalidateQueries({ queryKey: ["plan-approval", planRunId] });
			void cache.invalidateQueries({ queryKey: ["plan-runs"] });
		},
	});
	return (
		<form
			className="space-y-4"
			onChange={() => setCommandKey(crypto.randomUUID())}
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<p className="text-(--color-text-2) text-sm">
				Only remaining tasks can change. Started tasks and their evidence stay attached to the
				original revision.
			</p>
			{tasks.map((task) => (
				<TaskDraftFields
					key={task.key}
					id={`${id}-${task.key}`}
					index={task.seq - 1}
					task={task}
					onChange={(next) =>
						setTasks(tasks.map((row) => (row.key === task.key ? { ...next, seq: task.seq } : row)))
					}
				/>
			))}
			<Button
				variant="outline"
				type="button"
				onClick={() => {
					const seq =
						Math.max(
							0,
							...approval.snapshot.tasks.map((task) => task.seq),
							...tasks.map((task) => task.seq),
						) + 1;
					setTasks([
						...tasks,
						{
							key: crypto.randomUUID(),
							seq,
							title: "",
							description: "",
							acceptance: "",
							dependencies: "",
							releaseAfter: false,
						},
					]);
					setCommandKey(crypto.randomUUID());
				}}
			>
				Add remaining task
			</Button>
			<details className="space-y-3">
				<summary className="cursor-pointer text-sm">Execution choices for remaining work</summary>
				{(["implementation", "review"] as const).map((role) => (
					<label key={role} htmlFor={`${id}-${role}`} className="block space-y-1 text-sm">
						<span>
							{role === "implementation" ? "Future executor model" : "Future reviewer model"} (
							{profiles[role].runtime})
						</span>
						<Input
							id={`${id}-${role}`}
							required
							value={profiles[role].model}
							onChange={(event) =>
								setProfiles({
									...profiles,
									[role]: { ...profiles[role], model: event.target.value },
								})
							}
						/>
					</label>
				))}
				<ProjectBudgetSettings value={budgets} onChange={setBudgets} />
			</details>
			<label htmlFor={`${id}-decision`} className="block space-y-1 text-sm">
				<span>Decision and reason for revision</span>
				<Textarea
					id={`${id}-decision`}
					required
					value={decision}
					onChange={(event) => setDecision(event.target.value)}
				/>
			</label>
			{save.isError ? (
				<Alert variant="danger" title="Revision was not accepted">
					{formatError(save.error)}
					<Button
						variant="outline"
						onClick={() => void cache.invalidateQueries({ queryKey: ["plan-approval", planRunId] })}
					>
						Reload current revision
					</Button>
				</Alert>
			) : null}
			<Button type="submit" disabled={save.isPending || tasks.length === 0}>
				{save.isPending ? "Saving decision…" : "Approve revised remaining tasks"}
			</Button>
		</form>
	);
}
