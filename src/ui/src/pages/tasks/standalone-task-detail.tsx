import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { runsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useEventStream } from "@/hooks/use-event-stream.ts";
import { formatError } from "@/lib/format-error.ts";
import { CancelRunButton } from "../run-detail/steering-panel.tsx";
import { standaloneStatus } from "./standalone-tasks.ts";
import { taskCopy } from "./task-copy.ts";
import { TaskStatusMessage } from "./task-status-message.tsx";

export function StandaloneTaskDetail() {
	const { id = "" } = useParams();
	const [params] = useSearchParams();
	const originalId = params.get("original") ?? id;
	const current = useQuery({
		queryKey: ["runs", id],
		queryFn: ({ signal }) => runsApi.get(id, signal),
		refetchInterval: 10_000,
	});
	const original = useQuery({
		queryKey: ["runs", originalId],
		queryFn: ({ signal }) => runsApi.get(originalId, signal),
	});
	const run = current.data;
	const { events } = useEventStream(id, run?.state === "running");
	if (current.isPending || original.isPending) return <Spinner label="Loading task" />;
	if (!run || !original.data)
		return (
			<Alert variant="danger" title="Task unavailable">
				{formatError(current.error ?? original.error)}
			</Alert>
		);
	const copy = taskCopy(original.data.prompt);
	const preparation = events.filter((event) => event.kind.startsWith("preparation.")).at(-1);
	return (
		<div className="space-y-4 px-3.5 py-6 md:px-6">
			<Link
				className="text-(--color-primary) text-sm"
				to={run.projectId ? `/tasks?project=${encodeURIComponent(run.projectId)}` : "/tasks"}
			>
				← Tasks
			</Link>
			<h1 className="break-words font-semibold text-xl">{copy.title}</h1>
			<p className="wrap-anywhere whitespace-pre-line text-(--color-text-2) text-sm">
				{copy.description}
			</p>
			{current.isError || original.isError ? (
				<Alert variant="warning" title="Task updates unavailable">
					Showing the last known state. {formatError(current.error ?? original.error)}
				</Alert>
			) : null}
			<TaskStatusMessage status={standaloneStatus(run)} />
			{preparation?.kind === "preparation.failed" ? (
				<Alert variant="warning" title="Environment preparation failed">
					The project environment failed before execution or verification. Open diagnostics for the
					failing setup step.
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-4 text-sm">
				{run.projectId ? (
					<Link
						className="text-(--color-primary)"
						to={`/projects/${encodeURIComponent(run.projectId)}`}
					>
						Project and release
					</Link>
				) : null}
				{run.prUrl ? (
					<a className="text-(--color-primary)" href={run.prUrl} target="_blank" rel="noreferrer">
						Pull request ↗
					</a>
				) : null}
				<Link className="text-(--color-primary)" to={`/runs/${encodeURIComponent(id)}`}>
					Open diagnostics and attempt history
				</Link>
			</div>
			{run.state === "running" || run.state === "queued" ? (
				<OperatorOnly capability="dispatch">
					<CancelRunButton runId={id} disabled={false} onSettled={() => void current.refetch()} />
				</OperatorOnly>
			) : null}
		</div>
	);
}
