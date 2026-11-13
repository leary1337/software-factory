import { useMutation, useQueryClient } from "@tanstack/react-query";
import { planRunsApi } from "@/api/client.ts";
import type { PlanRunChildRow, PlanRunRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatError } from "@/lib/format-error.ts";

export function RetryReview({ plan, child }: { plan: PlanRunRow; child: PlanRunChildRow }) {
	const qc = useQueryClient();
	const retry = useMutation({
		mutationFn: () => planRunsApi.retryReview(plan.id, child.seq),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["plan-runs"] }),
	});
	if (
		plan.state !== "running" ||
		plan.agentName !== "implementer" ||
		child.state !== "pr_open" ||
		child.reviewStage !== "needs_attention"
	)
		return null;
	return (
		<OperatorOnly>
			<div className="space-y-2">
				{child.reviewFailure ? (
					<p className="wrap-anywhere whitespace-pre-wrap text-sm">{child.reviewFailure}</p>
				) : null}
				<p className="text-(--color-text-2) text-sm">
					After fixing the cause, retry review on the existing pull request.
				</p>
				<Button
					variant="outline"
					disabled={retry.isPending || retry.isSuccess}
					onClick={() => retry.mutate()}
				>
					{retry.isPending || retry.isSuccess ? "Review retry requested…" : "Retry review"}
				</Button>
				{retry.error ? (
					<p role="alert" className="text-(--color-danger) text-sm">
						{formatError(retry.error)}
					</p>
				) : null}
			</div>
		</OperatorOnly>
	);
}
