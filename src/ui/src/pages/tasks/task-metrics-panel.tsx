import type { PlanRunChildRow } from "@/api/types.ts";

function duration(ms: number | null): string {
	if (ms === null) return "Unknown";
	return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

export function TaskMetricsPanel({ child }: { child: PlanRunChildRow }) {
	const metrics = child.metrics;
	if (!metrics) return null;
	const partial =
		metrics.incomplete || metrics.tokenUnknownRuns > 0 || metrics.durationUnknownRuns > 0;
	const figures = [
		["Runs in this task", String(metrics.runCount)],
		["Active execution time", duration(metrics.activeMs)],
		["Time to delivery", duration(metrics.deliveryMs)],
		["Tokens reported", metrics.totalTokens?.toLocaleString() ?? "Unknown"],
		["Reworks", String(metrics.reworkCount)],
		[
			"Accepted without rework",
			metrics.firstPass === null ? "Not established" : metrics.firstPass ? "Yes" : "No",
		],
		["Observed steering / resumes", `${metrics.steeringCount} / ${metrics.resumeCount}`],
		["Post-merge incidents", String(metrics.postMergeIncidentCount)],
	];
	return (
		<section
			className="space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4"
			aria-label="Task totals"
		>
			<h2 className="font-semibold">Whole-task totals</h2>
			<dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
				{figures.map(([label, value]) => (
					<div key={label}>
						<dt className="text-(--color-text-2) text-xs">{label}</dt>
						<dd className="mt-1 break-words font-medium text-sm">{value}</dd>
					</div>
				))}
			</dl>
			<p className="text-(--color-text-2) text-xs">
				Includes implementation, reviews and reworks. Manual edits and rollbacks outside the factory
				are not measured.
			</p>
			{partial ? (
				<p className="text-(--color-warning) text-sm">
					Partial totals. Unknown measurements: tokens for {metrics.tokenUnknownRuns} runs, time for{" "}
					{metrics.durationUnknownRuns} runs. Missing linked runs: {metrics.missingRunCount}.
				</p>
			) : null}
		</section>
	);
}
