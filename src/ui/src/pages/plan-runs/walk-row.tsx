import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { PlanStateLabel } from "./plan-state-label.tsx";
import { childSummary, planRunElapsed } from "./walk-state.ts";

/** One responsive row, shared by phone and desktop so names and progress cannot drift. */
export function WalkRow({
	planRun,
	projectLabel,
	now,
}: {
	planRun: PlanRunRow;
	projectLabel: string;
	now: number;
}) {
	const detail = useQuery({
		queryKey: ["plan-runs", planRun.id],
		queryFn: ({ signal }) => planRunsApi.get(planRun.id, signal),
		// Lifecycle events refresh rows; this timer only covers missed notifications.
		refetchInterval: 45_000,
	});
	const currentPlan = detail.data?.planRun ?? planRun;
	const label =
		currentPlan.planName ?? (currentPlan.source === "issues" ? "Selected issues" : "Plan attempt");
	return (
		<article className="grid gap-4 p-4 text-sm lg:grid-cols-12">
			<div className="min-w-0 space-y-2 lg:col-span-4">
				<Link
					className="wrap-anywhere block font-medium text-sm leading-6 hover:underline"
					to={`/plan-runs/${encodeURIComponent(planRun.id)}`}
				>
					{label}
				</Link>
				<p className="wrap-anywhere text-(--color-text-2) text-xs">
					{projectLabel.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}
				</p>
				<p className="text-(--color-text-2) text-xs" title={formatTimestamp(currentPlan.startedAt)}>
					Started {relativeTime(currentPlan.startedAt)} · Duration{" "}
					{planRunElapsed(currentPlan, now)}
				</p>
			</div>
			<div className="lg:col-span-2">
				<PlanStateLabel state={currentPlan.state} tasks={detail.data?.children} />
			</div>
			<div className="min-w-0 space-y-2 lg:col-span-6">
				<p className="text-(--color-text-2) text-xs">Progress</p>
				<p className="wrap-anywhere leading-6">
					{detail.data
						? childSummary(currentPlan.state, detail.data.children)
						: detail.isError
							? "Progress unknown"
							: "Loading progress…"}
				</p>
				{detail.isError ? (
					<div className="space-y-2 text-(--color-warning) text-xs">
						<p>Progress unavailable or out of date.</p>
						<Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
							Retry plan data
						</Button>
					</div>
				) : null}
			</div>
		</article>
	);
}
