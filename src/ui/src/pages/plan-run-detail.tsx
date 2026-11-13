import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleStop } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { CancelPlanRunResponse, PlanRunDetailResponse } from "@/api/types.ts";
import { isTerminalPlanRunState } from "@/api/types.ts";
import { useWorkspaceReturn } from "@/components/console/workspace-navigation.tsx";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { formatPlanRunFailureReason } from "@/lib/labels.ts";
import { ChildWalkPanel } from "./plan-run-detail/child-walk.tsx";
import { DetailRail } from "./plan-run-detail/detail-rail.tsx";
import { TaskDetail } from "./plan-run-detail/task-detail.tsx";
import { PlanStateLabel } from "./plan-runs/plan-state-label.tsx";
import { PlanProgress } from "./tasks/plan-progress.tsx";

/**
 * Plan run detail — the Direction C walk inspector (warren-2520 /
 * pl-7e38 step 8, from docs/ui-revamp/screens/plan-run-detail.jsx).
 * Child-by-child gate state in the main panel, the source plan
 * definition + prompt + delivered PRs in the right rail. Attempt progress
 * separates confirmed delivery from tracker closures.
 *
 * Keeps the legacy page's data behavior: one `GET /plan-runs/:id`
 * round-trip under the `["plan-runs", id]` key (shared with the
 * inventory's per-row detail fetch), 5s poll while active, and the
 * Tier-1 lifecycle stream invalidates the key globally
 * (use-lifecycle-stream-invalidation). The read surface is readPublic,
 * so a spectator sees the same walk read-only — the only operator
 * affordance is the Cancel plan run button, which `OperatorOnly` drops.
 */

const ACTIVE_STATES = new Set<PlanRunDetailResponse["planRun"]["state"]>(["queued", "running"]);

export function PlanRunDetailPage() {
	const { id = "" } = useParams<{ id: string }>();
	const qc = useQueryClient();
	const [search] = useSearchParams();
	const backToPlans = useWorkspaceReturn("/plan-runs");

	const detail = useQuery({
		queryKey: ["plan-runs", id],
		queryFn: ({ signal }) => planRunsApi.get(id, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			if (!data) return 5000;
			return isTerminalPlanRunState(data.planRun.state) ? false : 5000;
		},
	});

	// Same key as the inventory pages: resolves the project git URL for
	// the hero meta line.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const cancel = useMutation({
		mutationFn: () => planRunsApi.cancel(id),
		onSettled: () => qc.invalidateQueries({ queryKey: ["plan-runs"] }),
	});

	if (detail.isLoading) {
		return <Spinner label="Loading plan run" />;
	}
	if (detail.isError && !detail.data) {
		return (
			<Alert variant="danger" title="Failed to load plan run">
				{formatError(detail.error)}{" "}
				<Button variant="outline" onClick={() => void detail.refetch()}>
					Retry
				</Button>
			</Alert>
		);
	}
	if (!detail.data) return null;
	const { planRun, children, runs } = detail.data;

	const project = projects.data?.projects.find((p) => p.id === planRun.projectId);
	const projectLabel =
		project?.gitUrl.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") ||
		"Project unavailable";
	const canCancel = ACTIVE_STATES.has(planRun.state);
	const refreshWarning = (
		<PlanRefreshWarning isError={detail.isError} retry={() => void detail.refetch()} />
	);

	if (search.has("task")) {
		const child = children.find((entry) => entry.seq === Number(search.get("task")));
		return child ? (
			<>
				{refreshWarning}
				<TaskDetail detail={detail.data} child={child} />
			</>
		) : (
			<Alert title="Task not found" variant="warning">
				<Link to={`/plan-runs/${encodeURIComponent(id)}`}>Back to plan</Link>
			</Alert>
		);
	}

	return (
		<div className="flex min-h-full flex-col px-3.5 py-6 md:px-6">
			<Link {...backToPlans} className="mb-4 text-(--color-primary) text-sm">
				← Back to plans
			</Link>
			<header className="flex shrink-0 flex-wrap items-center gap-3 pb-5">
				<div className="min-w-0 basis-full space-y-2 md:flex-1">
					<h1 className="wrap-anywhere font-semibold text-xl">
						{planRun.planName ?? "Plan attempt"}
					</h1>
					<p className="wrap-anywhere text-(--color-text-2) text-sm">{projectLabel}</p>
				</div>
				<PlanStateLabel state={planRun.state} tasks={children} />
				{canCancel ? (
					<OperatorOnly>
						<div className="flex flex-col items-end gap-1">
							<Button
								variant="outline"
								type="button"
								onClick={() => cancel.mutate()}
								disabled={cancel.isPending}
							>
								<CircleStop className="h-4 w-4 text-(--color-danger)" aria-hidden />
								{cancel.isPending ? "Cancelling…" : "Cancel plan run"}
							</Button>
							<CancelStatus mutation={cancel} />
						</div>
					</OperatorOnly>
				) : null}
			</header>

			{planRun.state === "failed" && planRun.failureReason != null ? (
				<Alert variant="danger" title="Walk failed">
					{/* Prose for the visitor, raw reason in the tooltip for the
					    operator (warren-14fc / #641). Redacted to undefined for
					    spectators (warren-17d7). */}
					<span title={planRun.failureReason}>
						{formatPlanRunFailureReason(planRun.failureReason)}
					</span>
				</Alert>
			) : null}

			{refreshWarning}
			<PlanProgress plan={planRun} tasks={children} />

			{/* items-start: the child walk sizes to its rows rather than
			    stretching to the rail's height (warren-dac1). */}
			<div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:items-start">
				<ChildWalkPanel planRun={planRun} childRows={children} runs={runs} />
				<DetailRail detail={detail.data} projectLabel={projectLabel} />
			</div>
		</div>
	);
}

function CancelStatus({
	mutation,
}: {
	mutation: ReturnType<typeof useMutation<CancelPlanRunResponse, Error, void>>;
}) {
	if (mutation.isError) {
		return <p className="text-(--color-danger) text-xs">{formatError(mutation.error)}</p>;
	}
	if (mutation.isSuccess && mutation.data !== undefined) {
		return (
			<p className="text-(--color-success) text-xs">
				{mutation.data.alreadyTerminal
					? "Walk was already terminal."
					: `Cancel forwarded${mutation.data.cancelledChild !== null ? ` (child ${mutation.data.cancelledChild.childSeq})` : ""}.`}
			</p>
		);
	}
	return null;
}

function PlanRefreshWarning({ isError, retry }: { isError: boolean; retry: () => void }) {
	return isError ? (
		<Alert variant="warning" title="Plan updates unavailable">
			Showing the last known task states.{" "}
			<Button variant="outline" onClick={retry}>
				Retry plan
			</Button>
		</Alert>
	) : null;
}
