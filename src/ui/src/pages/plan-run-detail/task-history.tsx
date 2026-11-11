import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { PlanRunChildRow, RunRow } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { SelectInput } from "@/components/ui/select-input.tsx";
import { ReviewReport } from "../run-detail/review-report.tsx";
import { type HistoryFilter, historyEntries, historyResult } from "./history-entries.ts";

const PAGE_SIZE = 8;

export function TaskHistory({ child, run }: { child: PlanRunChildRow; run: RunRow | undefined }) {
	const id = useId();
	const [filter, setFilter] = useState<HistoryFilter>("all");
	const [oldestFirst, setOldestFirst] = useState(false);
	const [limit, setLimit] = useState(PAGE_SIZE);
	const entries = historyEntries(child.reviewSteps ?? []);
	const filtered = entries.filter(({ step }) => filter === "all" || step.step === filter);
	const ordered = oldestFirst ? filtered : [...filtered].reverse();
	const latestReview = [...entries].reverse().find(({ step }) => step.step !== "rework");
	const reviewCount = entries.filter(({ step }) => step.step === "review").length;
	const uiCount = entries.filter(({ step }) => step.step === "ui_review").length;
	const reworkCount = entries.filter(({ step }) => step.step === "rework").length;
	return (
		<section
			aria-label="Execution history"
			className="space-y-4 rounded-lg border border-(--color-border) bg-(--color-surface) p-4"
		>
			<header className="space-y-2">
				<h2 className="font-semibold text-base">Execution history</h2>
				{child.reviewSteps ? (
					<p className="text-(--color-text-2) text-sm">
						{reviewCount} code reviews · {uiCount} UI/UX reviews · {reworkCount} reworks
					</p>
				) : null}
			</header>
			<div className="flex flex-wrap gap-3">
				<label htmlFor={`${id}-type`} className="flex flex-col gap-1 text-(--color-text-2) text-xs">
					Show
					<SelectInput
						id={`${id}-type`}
						aria-label="History type"
						value={filter}
						onChange={(event) => {
							setFilter(event.target.value as HistoryFilter);
							setLimit(PAGE_SIZE);
						}}
					>
						<option value="all">All steps</option>
						<option value="review">Code reviews</option>
						<option value="ui_review">UI/UX reviews</option>
						<option value="rework">Reworks</option>
					</SelectInput>
				</label>
				<label
					htmlFor={`${id}-order`}
					className="flex flex-col gap-1 text-(--color-text-2) text-xs"
				>
					Order
					<SelectInput
						id={`${id}-order`}
						aria-label="History order"
						value={oldestFirst ? "oldest" : "newest"}
						onChange={(event) => {
							setOldestFirst(event.target.value === "oldest");
							setLimit(PAGE_SIZE);
						}}
					>
						<option value="newest">Newest first</option>
						<option value="oldest">Oldest first</option>
					</SelectInput>
				</label>
			</div>
			{child.reviewSteps === undefined ? (
				<p className="text-(--color-text-2) text-sm">
					Detailed review history is available to the operator.
				</p>
			) : ordered.length === 0 ? (
				<p className="text-(--color-text-2) text-sm">
					{entries.length
						? "No steps match this filter."
						: "No review steps have been recorded yet."}
				</p>
			) : null}
			<ol className="space-y-3">
				{ordered.slice(0, limit).map(({ step, label }) => (
					<li key={step.runId} className="space-y-2 border-(--color-border) border-t pt-3">
						<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
							<Link
								className="font-medium text-(--color-primary) hover:underline"
								to={`/runs/${encodeURIComponent(step.runId)}`}
							>
								{label}
							</Link>
							<span>{historyResult(step)}</span>
						</div>
						{step.summary && step.step !== "rework" ? (
							<details open={step.runId === latestReview?.step.runId} className="text-sm">
								<summary className="cursor-pointer text-(--color-text-2)">
									Report for {label}
								</summary>
								<div className="mt-2">
									<ReviewReport summary={step.summary} executionState={step.executionState} />
								</div>
							</details>
						) : null}
					</li>
				))}
			</ol>
			{ordered.length > limit ? (
				<Button variant="outline" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
					Show more steps ({ordered.length - limit} remaining)
				</Button>
			) : null}
			{child.reviewSteps ? (
				<p className="text-(--color-text-2) text-xs">
					Showing {Math.min(limit, ordered.length)} of {ordered.length} matching steps. Step links
					open their execution logs.
				</p>
			) : null}
			{run ? (
				<p className="flex flex-wrap gap-2 border-(--color-border) border-t pt-3 text-sm">
					<Link
						className="text-(--color-primary) hover:underline"
						to={`/runs/${encodeURIComponent(run.id)}`}
					>
						Implementation
					</Link>
					<span>Execution: {run.state}</span>
				</p>
			) : (
				<p className="text-(--color-text-2) text-sm">Implementation has not started.</p>
			)}
		</section>
	);
}
