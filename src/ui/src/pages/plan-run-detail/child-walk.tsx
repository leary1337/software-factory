import { Link } from "react-router-dom";
import type { PlanRunChildRow, PlanRunRow, RunRow } from "@/api/types.ts";
import { costText, taskCost } from "../tasks/cost-summary.ts";
import { planProgressText } from "../tasks/plan-progress-summary.ts";
import { taskExecutionId } from "../tasks/task-attempts.ts";
import { taskStatus } from "../tasks/task-status.ts";
import { RetryReview } from "./retry-review.tsx";

export function ChildWalkPanel({
	planRun,
	childRows,
	runs,
}: {
	planRun: PlanRunRow;
	childRows: PlanRunChildRow[];
	runs: RunRow[];
}) {
	const children = [...childRows].sort((a, b) => a.seq - b.seq);
	const gate = children.find((child) => child.state !== "merged" && child.state !== "skipped");
	const isOpen = planRun.state === "running" || planRun.state === "queued";
	const runIndex = new Map(runs.map((run) => [run.id, run]));
	return (
		<section
			aria-label="Plan tasks"
			className="min-w-0 flex-1 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface)"
		>
			<header className="space-y-1 border-(--color-border) border-b p-4">
				<h2 className="font-semibold text-base">Tasks in this plan</h2>
				<p className="text-(--color-text-2) text-xs">{children.length} tasks · executed in order</p>
			</header>
			{children.length === 0 ? (
				<p className="p-4 text-(--color-text-2) text-sm">No tasks were included in this attempt.</p>
			) : (
				<ol className="divide-y divide-(--color-border)">
					{children.map((child) => (
						<ChildRow
							key={child.seq}
							child={child}
							plan={planRun}
							run={child.runId ? runIndex.get(child.runId) : undefined}
							gate={isOpen ? gate : undefined}
						/>
					))}
				</ol>
			)}
			<footer className="space-y-2 border-(--color-border) border-t p-4 text-(--color-text-2) text-xs">
				<p>{planProgressText(childRows, planRun.state)}</p>
				<p>Starting this plan again resumes from the next open task.</p>
			</footer>
		</section>
	);
}

function ChildRow({
	child,
	plan,
	run,
	gate,
}: {
	child: PlanRunChildRow;
	plan: PlanRunRow;
	run: RunRow | undefined;
	gate: PlanRunChildRow | undefined;
}) {
	const status = taskStatus(child, plan);
	const logId = taskExecutionId(child) ?? child.runId;
	const current = gate?.seq === child.seq;
	const waitingOnGate = child.state === "pending" && gate && gate.seq < child.seq;
	return (
		<li className={`space-y-3 p-4 ${current ? "bg-(--color-surface-raised)" : ""}`}>
			<div className="grid items-start gap-2 md:grid-cols-3">
				<div className="min-w-0 space-y-1 md:col-span-2">
					<p className="text-(--color-text-2) text-xs">
						Task {child.seq}
						{current ? " · Current task" : ""}
					</p>
					<Link
						className="wrap-anywhere block font-medium text-sm leading-6 hover:underline"
						to={`/plan-runs/${encodeURIComponent(child.planRunId)}?task=${child.seq}`}
					>
						{child.title ?? `Task ${child.seq}`}
					</Link>
				</div>
				<span
					className={`text-sm ${status.group === "attention" ? "text-(--color-warning)" : "text-(--color-text-2)"}`}
				>
					{status.label}
				</span>
			</div>
			<p className="wrap-anywhere text-(--color-text-2) text-xs">
				{waitingOnGate
					? `Waiting for “${gate.title ?? `Task ${gate.seq}`}” to finish.`
					: status.action}
			</p>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
				<span className="text-(--color-text-2)">Task cost: {costText(taskCost(child))}</span>
				{logId ? (
					<Link
						className="text-(--color-primary) hover:underline"
						to={`/runs/${encodeURIComponent(logId)}`}
					>
						Execution log
					</Link>
				) : null}
				{run?.prUrl ? (
					<a
						className="text-(--color-primary) hover:underline"
						href={run.prUrl}
						target="_blank"
						rel="noreferrer noopener"
					>
						Pull request ↗
					</a>
				) : null}
				{child.retryCount > 0 ? (
					<span className="text-(--color-text-2)">{child.retryCount} implementation retries</span>
				) : null}
			</div>
			{current ? (
				<RetryReview
					key={`${child.reviewStage}:${child.reviewFailure}`}
					plan={plan}
					child={child}
				/>
			) : null}
		</li>
	);
}
