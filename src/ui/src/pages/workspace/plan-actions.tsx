import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatError } from "@/lib/format-error.ts";

export function PlanActions({ plan }: { plan: PlanRunRow }) {
	const qc = useQueryClient();
	const active = plan.state === "running" || plan.state === "queued";
	const resumable =
		plan.state === "failed" &&
		["child_pr_merge_timeout", "parent_pr_merge_timeout"].includes(plan.failureReason ?? "");
	const action = useMutation({
		mutationFn: () => (active ? planRunsApi.cancel(plan.id) : planRunsApi.resume(plan.id)),
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["plan-runs"] });
			void qc.invalidateQueries({ queryKey: ["runs"] });
		},
	});
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" asChild>
					<Link to={`/plan-runs/${encodeURIComponent(plan.id)}`}>Открыть план →</Link>
				</Button>
				{active || resumable ? (
					<Button variant="outline" disabled={action.isPending} onClick={() => action.mutate()}>
						{active ? "Остановить план" : "Продолжить проверку PR"}
					</Button>
				) : null}
			</div>
			{action.error ? <Alert variant="danger">{formatError(action.error)}</Alert> : null}
		</div>
	);
}
