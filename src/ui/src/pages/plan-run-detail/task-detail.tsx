import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunDetailResponse } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { ReviewReport } from "../run-detail/review-report.tsx";
import { childStateLabel } from "./child-walk.tsx";
import { DeploymentIncident } from "./deployment-incident.tsx";

function nextAction(child: PlanRunChildRow): string {
	if (child.state === "merged") return "The pull request is merged. This task is complete.";
	if (child.failureReason === "deployment_incident")
		return "Inspect production and explicitly resume verification after resolving the incident.";
	if (child.state === "failed") return "Inspect the failed execution before retrying this task.";
	if (child.state === "skipped") return "This task was skipped.";
	if (child.reviewStage === "reworking") return "Rework is addressing the review findings.";
	if (child.reviewStage === "reviewing") return "Wait for the independent review result.";
	if (child.reviewStage === "needs_attention")
		return "Review the findings and decide how to continue.";
	if (child.state === "pr_open") return "The next task waits for this pull request to merge.";
	if (child.state === "pending") return "This task waits for its turn in the plan.";
	return "Implementation is in progress. Review starts after the pull request opens.";
}

export function TaskDetail({
	detail,
	child,
}: {
	detail: PlanRunDetailResponse;
	child: PlanRunChildRow;
}) {
	const run = detail.runs.find((entry) => entry.id === child.runId);
	const steps = child.reviewSteps ?? [];
	let reviews = 0;
	let reworks = 0;
	let uiReviews = 0;
	return (
		<div className="flex min-h-full flex-col gap-4 px-3.5 py-6 md:px-6">
			<Link
				to={`/plan-runs/${encodeURIComponent(detail.planRun.id)}`}
				className="text-(--color-primary) text-sm hover:underline"
			>
				← Back to plan
			</Link>
			<header className="flex flex-wrap items-center gap-3">
				<h1 className="min-w-0 break-words font-semibold text-xl">
					{child.title ?? `Task ${child.seq}`}
				</h1>
				<span className="rounded border border-(--color-border) px-2 py-1 text-xs">
					{childStateLabel(child)}
				</span>
				{run?.prUrl ? (
					<a
						href={run.prUrl}
						target="_blank"
						rel="noreferrer noopener"
						className="text-(--color-primary) text-sm hover:underline"
					>
						Open pull request ↗
					</a>
				) : null}
			</header>
			<Alert
				className="text-(--color-fg)"
				title="Next action"
				variant={child.reviewStage === "needs_attention" ? "warning" : "info"}
			>
				{nextAction(child)}
			</Alert>
			{child.failureReason === "deployment_incident" ? (
				<DeploymentIncident planRunId={detail.planRun.id} runId={child.runId} />
			) : child.failureReason ? (
				<Alert className="text-(--color-fg)" title="Task stopped" variant="danger">
					{child.failureReason}
				</Alert>
			) : null}
			<section className="rounded border border-(--color-border) bg-(--color-surface) p-4">
				<h2 className="mb-3 font-semibold text-base">Execution history</h2>
				{run ? (
					<div className="mb-3 flex flex-wrap gap-2 text-sm">
						<Link
							className="text-(--color-primary) hover:underline"
							to={`/runs/${encodeURIComponent(run.id)}`}
						>
							Implementation
						</Link>
						<span>Execution: {run.state}</span>
					</div>
				) : (
					<p className="text-(--color-text-2) text-sm">Implementation has not started.</p>
				)}
				{steps.map((step) => {
					const label =
						step.step === "review"
							? `Review ${++reviews}`
							: step.step === "ui_review"
								? `UI/UX review ${++uiReviews}`
								: `Rework ${++reworks}`;
					return (
						<article
							key={step.runId}
							className="mt-3 space-y-2 border-(--color-border) border-t pt-3"
						>
							<div className="flex flex-wrap gap-2 text-sm">
								<Link
									className="text-(--color-primary) hover:underline"
									to={`/runs/${encodeURIComponent(step.runId)}`}
								>
									{label}
								</Link>
								<span>Execution: {step.executionState}</span>
							</div>
							{step.summary ? (
								<ReviewReport summary={step.summary} executionState={step.executionState} />
							) : null}
						</article>
					);
				})}
				{child.reviewSteps === undefined ? (
					<p className="mt-2 text-(--color-text-2) text-sm">
						Detailed review history is available to the operator.
					</p>
				) : steps.length === 0 ? (
					<p className="mt-2 text-(--color-text-2) text-sm">
						No review steps have been recorded yet.
					</p>
				) : null}
			</section>
			{run?.prompt ? (
				<details className="rounded border border-(--color-border) bg-(--color-surface) p-4">
					<summary className="cursor-pointer font-medium text-sm">Task instructions</summary>
					<p className="wrap-anywhere mt-3 whitespace-pre-wrap text-sm">{run.prompt}</p>
				</details>
			) : null}
		</div>
	);
}
