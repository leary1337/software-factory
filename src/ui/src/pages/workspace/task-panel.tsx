import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import { isTerminalRunState, type RunRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useEventStream } from "@/hooks/use-event-stream.ts";
import { formatError } from "@/lib/format-error.ts";
import { DeploymentIncident } from "../plan-run-detail/deployment-incident.tsx";
import { TaskHistory } from "../plan-run-detail/task-history.tsx";
import { EventTail } from "../run-detail/event-tail.tsx";
import { TaskCostPanel } from "../tasks/cost-panel.tsx";
import { taskUrl } from "../tasks/task-attempts.ts";
import { TaskBudgetPanel } from "../tasks/task-budget-panel.tsx";
import { taskStatus } from "../tasks/task-status.ts";
import { TaskStatusMessage } from "../tasks/task-status-message.tsx";
import { PlanActions } from "./plan-actions.tsx";
import { RunActions } from "./run-actions.tsx";
import type { WorkspaceTask } from "./task-model.ts";

function RunLogs({ run }: { run: RunRow }) {
	const terminal = isTerminalRunState(run.state);
	const stream = useEventStream(run.id, !terminal);
	return <EventTail runId={run.id} {...stream} terminal={terminal} />;
}

function CurrentExecution({ task }: { task: WorkspaceTask }) {
	const runId = task.runId;
	const query = useQuery({
		queryKey: ["runs", runId],
		queryFn: ({ signal }) => runsApi.get(runId ?? "", signal),
		enabled: !!runId,
		refetchInterval: 3_000,
	});
	const run = query.data;
	if (!runId)
		return <p className="text-(--color-text-2) text-sm">Следующее исполнение ещё не началось.</p>;
	if (query.isLoading) return <Spinner label="Загрузка исполнения" />;
	return (
		<div className="space-y-4">
			{query.error ? (
				<Alert variant="danger">
					{formatError(query.error)}{" "}
					<Button variant="outline" onClick={() => void query.refetch()}>
						Повторить
					</Button>
				</Alert>
			) : null}
			{run ? (
				<>
					<div className="flex flex-wrap items-center gap-3 text-sm">
						<span>
							{run.agentName} · {run.state}
						</span>
						<Link className="text-(--color-primary)" to={`/runs/${encodeURIComponent(run.id)}`}>
							Открыть run ↗
						</Link>
					</div>
					<OperatorOnly>
						<RunActions key={run.id} run={run} planId={task.currentPlan?.detail.planRun.id} />
					</OperatorOnly>
					<details className="rounded-lg border border-(--color-border) p-3">
						<summary className="cursor-pointer text-sm">Logs</summary>
						<div className="mt-3">
							<RunLogs key={run.id} run={run} />
						</div>
					</details>
				</>
			) : null}
		</div>
	);
}

function TaskAttention({ task }: { task: WorkspaceTask }) {
	const current = task.currentPlan;
	return (
		<>
			{task.attention ? (
				<Alert variant="warning" title="Требует тебя">
					{current ? (
						<TaskStatusMessage status={taskStatus(current.child, current.detail.planRun)} />
					) : (
						task.reason
					)}
				</Alert>
			) : null}
		</>
	);
}

export function TaskPanel({ task, onClose }: { task: WorkspaceTask; onClose: () => void }) {
	const current = task.currentPlan;
	const implementation =
		current?.detail.runs.find((run) => run.id === current.child.runId) ??
		task.runs.find((run) => run.id === task.runId);
	const receipt = current?.child.productionVerification;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="inset-y-0 right-0 left-auto block h-dvh max-w-2xl translate-x-0 translate-y-0 space-y-5 overflow-y-auto rounded-none p-5 sm:rounded-none md:p-6">
				<DialogTitle className="break-words pr-7 leading-7">{task.title}</DialogTitle>
				<DialogDescription>
					{task.column}
					{task.attention ? " · Требуется твоё действие" : ""}
				</DialogDescription>
				<TaskAttention task={task} />
				<div className="flex flex-wrap gap-2">
					{implementation?.prUrl ? (
						<Button variant="outline" asChild>
							<a href={implementation.prUrl} target="_blank" rel="noreferrer">
								Открыть PR ↗
							</a>
						</Button>
					) : null}
					{task.projectId ? (
						<Button variant="outline" asChild>
							<Link to={`/production?project=${encodeURIComponent(task.projectId)}`}>
								Production →
							</Link>
						</Button>
					) : null}
				</div>
				{receipt ? (
					<Alert title="Production проверен">
						{receipt.environment} · {receipt.sha.slice(0, 7)}
						<p>Проверка выполнена {receipt.verifiedAt}. Текущий Release проекта — в Production.</p>
					</Alert>
				) : task.column === "Merged" ? (
					<p className="text-(--color-text-2) text-sm">
						PR объединён. Подтверждение Production для этой задачи пока отсутствует.
					</p>
				) : null}
				{current?.child.failureReason === "deployment_incident" ? (
					<DeploymentIncident planRunId={current.detail.planRun.id} runId={current.child.runId} />
				) : null}
				{current ? (
					<OperatorOnly>
						<PlanActions plan={current.detail.planRun} />
					</OperatorOnly>
				) : null}
				<CurrentExecution task={task} />
				{current ? (
					<>
						<TaskBudgetPanel child={current.child} />
						<TaskCostPanel child={current.child} run={implementation} />
						<details className="rounded-lg border border-(--color-border) p-3">
							<summary className="cursor-pointer text-sm">Review и история попытки</summary>
							<div className="mt-3">
								<TaskHistory child={current.child} run={implementation} />
							</div>
						</details>
						{task.plan ? (
							<details className="rounded-lg border border-(--color-border) p-3">
								<summary className="cursor-pointer text-sm">
									Все попытки · {task.plan.attempts.length}
								</summary>
								<ul className="mt-3 space-y-2">
									{task.plan.attempts.map((attempt) => (
										<li key={`${attempt.detail.planRun.id}:${attempt.child.seq}`}>
											<Link className="text-(--color-primary) text-sm" to={taskUrl(attempt)}>
												{attempt.detail.planRun.planName ?? "План"} · {attempt.child.state} ·{" "}
												{attempt.detail.planRun.createdAt}
											</Link>
										</li>
									))}
								</ul>
							</details>
						) : null}
					</>
				) : null}
				{task.runs.length > 0 ? (
					<details className="rounded-lg border border-(--color-border) p-3">
						<summary className="cursor-pointer text-sm">Исполнения · {task.runs.length}</summary>
						<ul className="mt-3 space-y-2">
							{task.runs.map((run) => (
								<li key={run.id}>
									<Link
										className="text-(--color-primary) text-sm"
										to={`/runs/${encodeURIComponent(run.id)}`}
									>
										{run.agentName} · {run.state} · {run.startedAt ?? "Queued"}
									</Link>
								</li>
							))}
						</ul>
					</details>
				) : null}
				{implementation?.prompt ? (
					<details className="rounded-lg border border-(--color-border) p-3">
						<summary className="cursor-pointer text-sm">Описание задачи</summary>
						<p className="wrap-anywhere mt-3 whitespace-pre-wrap text-sm">
							{implementation.prompt}
						</p>
					</details>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
