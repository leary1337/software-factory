import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { planRunsApi, streamRunEvents } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { RollbackRecovery } from "../../../../core/task-recovery.ts";

export function DeploymentIncident({
	planRunId,
	runId,
	recovery,
}: {
	planRunId: string;
	runId: string | null;
	recovery?: RollbackRecovery | null;
}) {
	const qc = useQueryClient();
	const incident = useQuery({
		queryKey: ["deployment-incident", runId],
		enabled: runId !== null && !recovery,
		queryFn: async ({ signal }) => {
			let reason = "Inspect the deployment workflow and production before resuming.";
			for await (const event of streamRunEvents(runId ?? "", { signal })) {
				if (event.kind !== "plan_run.deployment_incident") continue;
				const payload = event.payload as { reason?: unknown };
				if (typeof payload.reason === "string") reason = payload.reason;
			}
			return reason;
		},
	});
	const resume = useMutation({
		mutationFn: () => planRunsApi.resume(planRunId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["plan-runs"] }),
	});
	return (
		<Alert className="text-(--color-fg)" title="Production needs attention" variant="danger">
			<div className="flex flex-col items-start gap-3">
				<p>
					{recovery
						? recovery.reason
						: incident.isLoading
							? "Loading incident details…"
							: (incident.data ?? "Production verification stopped.")}
				</p>
				{incident.error ? <p>{formatError(incident.error)}</p> : null}
				<p>
					The project queue is stopped. Resolve the production incident before resuming. Rechecking
					verifies the deployed release; it does not dispatch another deployment or rollback.
				</p>
				<OperatorOnly capability="dispatch">
					<Button variant="outline" disabled={resume.isPending} onClick={() => resume.mutate()}>
						{resume.isPending ? "Resuming…" : "Recheck production and resume"}
					</Button>
				</OperatorOnly>
				{resume.error ? <p>{formatError(resume.error)}</p> : null}
			</div>
		</Alert>
	);
}
