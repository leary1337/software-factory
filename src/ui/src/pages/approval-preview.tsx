import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { approvalsApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatError } from "@/lib/format-error.ts";
import type { PlanApproval } from "../../../core/plan-approval.ts";
import { useProjectReadiness } from "./project-readiness-panel.tsx";

export function ApprovalPreview(props: { approval: PlanApproval; onBack?: () => void }) {
	return (
		<OperatorOnly capability="dispatch">
			<ApprovalPreviewContent {...props} />
		</OperatorOnly>
	);
}

function ApprovalPreviewContent({
	approval,
	onBack,
}: {
	approval: PlanApproval;
	onBack?: () => void;
}) {
	const navigate = useNavigate();
	const readiness = useProjectReadiness(approval.snapshot.projectId);
	const canStart =
		!!approval.planRunId ||
		(!readiness.isError && readiness.data?.ready === true && !readiness.data.stale);
	const start = useMutation({
		mutationFn: () => approvalsApi.start(approval.id),
		onSuccess: (result) => navigate(`/plan-runs/${encodeURIComponent(result.planRun.id)}`),
	});
	const { snapshot } = approval;
	return (
		<section aria-label="Plan approval" className="space-y-4">
			<h3 className="font-semibold text-lg">{snapshot.title}</h3>
			<p className="text-(--color-text-2) text-sm">
				Review this saved plan before starting. Revision {approval.revision} fixes the tasks,
				permissions, execution profiles, tools and limits.
			</p>
			<dl className="grid gap-2 text-sm sm:grid-cols-2">
				<div>
					<dt className="text-(--color-text-2)">Executor</dt>
					<dd>
						{snapshot.profiles.implementation.runtime} · {snapshot.profiles.implementation.model}
					</dd>
				</div>
				<div>
					<dt className="text-(--color-text-2)">Reviewer</dt>
					<dd>
						{snapshot.profiles.review.runtime} · {snapshot.profiles.review.model}
					</dd>
				</div>
				<div className="min-w-0 sm:col-span-2">
					<dt className="text-(--color-text-2)">Shared tools version</dt>
					<dd className="break-all">{snapshot.toolkitVersion}</dd>
				</div>
			</dl>
			<p className="text-sm">
				Per task: {snapshot.budgets.repairs} repairs, {snapshot.budgets.reworks} reworks,{" "}
				{Math.round(snapshot.budgets.runMs / 60_000)} minutes per execution,{" "}
				{Math.round(snapshot.budgets.activeMs / 60_000)} active minutes,{" "}
				{Math.round(snapshot.budgets.externalWaitMs / 60_000)} minutes waiting externally.
			</p>
			<ol className="space-y-4">
				{snapshot.tasks.map((task) => (
					<li key={task.seq} className="space-y-2 rounded-md border border-(--color-border) p-3">
						<h4 className="font-medium">
							{task.seq}. {task.title}
						</h4>
						<p className="whitespace-pre-line text-sm">{task.description}</p>
						<ul className="list-inside list-disc text-(--color-text-2) text-sm">
							{task.acceptance.map((criterion) => (
								<li key={criterion}>{criterion}</li>
							))}
						</ul>
						<p className="text-sm">
							{task.dependsOn.length
								? `After tasks ${task.dependsOn.join(", ")}`
								: "No dependencies"}{" "}
							· {task.releaseAfter ? "Release after this stage" : "Release after the plan"}
						</p>
						{task.permissions.length ? (
							<ul className="text-(--color-warning) text-sm">
								{task.permissions.map((permission) => (
									<li key={`${permission.kind}:${permission.reason}`}>
										{permission.kind}: {permission.reason} ({permission.paths.join(", ")})
									</li>
								))}
							</ul>
						) : null}
					</li>
				))}
			</ol>
			{snapshot.permissions.length ? (
				<Alert variant="warning" title="Approved permissions">
					{snapshot.permissions.map((permission) => (
						<p key={`${permission.kind}:${permission.reason}`}>
							{permission.kind}: {permission.reason} ({permission.paths.join(", ")})
						</p>
					))}
				</Alert>
			) : (
				<p className="text-(--color-text-2) text-sm">
					Changes to access, destructive migrations and factory rules still require a separate
					decision unless listed for a task.
				</p>
			)}
			{start.isError ? (
				<Alert variant="danger" title="Could not confirm plan start">
					{formatError(start.error)} Retry uses the same saved plan and does not create another
					execution.
				</Alert>
			) : null}
			{!canStart ? (
				<p className="text-(--color-warning) text-sm">
					Complete the project readiness check before starting this plan.
				</p>
			) : null}
			<div className="flex flex-wrap gap-3">
				{onBack && !approval.planRunId ? (
					<Button variant="outline" onClick={onBack}>
						Edit before approval
					</Button>
				) : null}
				<Button disabled={start.isPending || !canStart} onClick={() => start.mutate()}>
					{start.isPending
						? "Starting saved plan…"
						: approval.planRunId
							? "Open started plan"
							: "Approve and start this plan"}
				</Button>
			</div>
		</section>
	);
}
