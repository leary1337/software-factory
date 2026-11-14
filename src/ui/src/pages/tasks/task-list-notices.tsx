import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";

interface QueryState {
	isLoading: boolean;
	isPending: boolean;
	isError: boolean;
	error: unknown;
	refetch: () => unknown;
}
export function TaskListNotices({
	plans,
	runs,
	projects,
	details,
	isEmpty,
	search,
}: {
	plans: QueryState;
	runs: QueryState;
	projects: QueryState;
	details: QueryState[];
	isEmpty: boolean;
	search: string;
}) {
	const failed = details.filter((query) => query.isError);
	const healthy = [plans, runs, ...details].every((query) => !query.isPending && !query.isError);
	return (
		<>
			{plans.isLoading || runs.isPending || details.some((query) => query.isLoading) ? (
				<Spinner label="Loading tasks" />
			) : null}
			{plans.isError ? (
				<Alert variant="danger" title="Could not load tasks">
					{formatError(plans.error)}{" "}
					<Button variant="outline" onClick={() => void plans.refetch()}>
						Retry
					</Button>
				</Alert>
			) : null}
			{runs.isError ? (
				<Alert variant="danger" title="Some tasks could not be loaded">
					The task queue may be incomplete.{" "}
					<Button variant="outline" onClick={() => void runs.refetch()}>
						Retry tasks
					</Button>
				</Alert>
			) : null}
			{projects.isError ? (
				<Alert variant="warning" title="Project names unavailable">
					Task results remain visible.{" "}
					<Button variant="outline" onClick={() => void projects.refetch()}>
						Retry project names
					</Button>
				</Alert>
			) : null}
			{failed.length > 0 ? (
				<Alert variant="danger" title="Some tasks could not be loaded">
					Some task states may be missing or out of date. Last known tasks remain visible.{" "}
					<Button
						variant="outline"
						onClick={() => {
							for (const query of failed) void query.refetch();
						}}
					>
						Retry missing tasks
					</Button>
				</Alert>
			) : null}
			{healthy && isEmpty ? (
				<Alert title="No tasks to show">
					{search
						? "No loaded tasks match your search."
						: "Start a plan or a task to follow its progress here."}
				</Alert>
			) : null}
		</>
	);
}
