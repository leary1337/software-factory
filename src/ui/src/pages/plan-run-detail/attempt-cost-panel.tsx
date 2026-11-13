import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunChildRow, PlanRunDetailResponse } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { AttemptCosts } from "../tasks/attempt-costs.tsx";
import { groupTaskAttempts, taskUrl } from "../tasks/task-attempts.ts";

/** Compare bounded project history without treating an unloaded attempt as zero. */
export function AttemptCostPanel({
	detail,
	child,
}: {
	detail: PlanRunDetailResponse;
	child: PlanRunChildRow;
}) {
	const [limit, setLimit] = useState(12);
	const plans = useQuery({
		queryKey: ["plan-runs", "attempt-costs", detail.planRun.projectId],
		queryFn: ({ signal }) => planRunsApi.list({ project: detail.planRun.projectId }, signal),
		refetchInterval: 45_000,
	});
	const ordered = [...(plans.data?.planRuns ?? [])].sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt),
	);
	const visible = ordered.slice(0, limit).filter((plan) => plan.id !== detail.planRun.id);
	const queries = useQueries({
		queries: visible.map((plan) => ({
			queryKey: ["plan-runs", plan.id],
			queryFn: ({ signal }: { signal: AbortSignal }) => planRunsApi.get(plan.id, signal),
			staleTime: 30_000,
			retry: false,
			refetchInterval:
				plan.state === "running" || plan.state === "queued" ? 45_000 : (false as const),
		})),
	});
	const selected = { detail, child, project: "" };
	const rows = [detail, ...queries.flatMap((query) => (query.data ? [query.data] : []))].flatMap(
		(entry) => entry.children.map((child) => ({ detail: entry, child, project: "" })),
	);
	const task = groupTaskAttempts(rows).find((item) =>
		item.attempts.some((attempt) => taskUrl(attempt) === taskUrl(selected)),
	);
	const failed = plans.isError || queries.some((query) => query.isError);
	const loadedCount = 1 + queries.filter((query) => query.data).length;
	return (
		<section
			aria-label="Attempt costs"
			className="space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Costs across attempts</h2>
			{plans.isLoading || queries.some((query) => query.isLoading) ? (
				<p className="text-(--color-text-2) text-sm">Loading earlier attempts…</p>
			) : null}
			{failed ? (
				<div className="space-y-2 text-(--color-warning) text-sm">
					<p>Some attempts are unavailable or out of date. The loaded subtotal may omit costs.</p>
					<Button
						variant="outline"
						onClick={() => {
							void plans.refetch();
							for (const query of queries) void query.refetch();
						}}
					>
						Retry attempt costs
					</Button>
				</div>
			) : null}
			<AttemptCosts attempts={task?.attempts ?? [selected]} selected={selected} />
			{ordered.length > limit ? (
				<Button variant="outline" onClick={() => setLimit((value) => value + 12)}>
					Load more attempts
				</Button>
			) : null}
			<p className="text-(--color-text-2) text-xs">
				Based on {loadedCount} loaded plan records, including this attempt. Each plan total includes
				its own tasks; this comparison includes only this task.
			</p>
		</section>
	);
}
