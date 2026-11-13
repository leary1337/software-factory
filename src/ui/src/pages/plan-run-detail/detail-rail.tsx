import type { PlanRunDetailResponse, RunRow } from "@/api/types.ts";
import { formatTimestamp } from "@/lib/utils.ts";
import { implementationLimitText } from "../tasks/cost-summary.ts";

export function DetailRail({
	detail,
	projectLabel,
}: {
	detail: PlanRunDetailResponse;
	projectLabel: string;
}) {
	const { planRun, children, runs } = detail;
	const delivered = collectDeliveredPrs(children, runs);
	return (
		<aside className="flex w-full min-w-0 flex-col gap-4 lg:w-80">
			<RailCard title="Plan definition">
				<Facts
					rows={[
						{ label: "Plan", value: planRun.planName ?? "Selected issues" },
						{ label: "Project", value: projectLabel },
						{
							label: "Implementation run limit",
							value: implementationLimitText(planRun.maxCostUsd),
						},
						{ label: "Started", value: formatTimestamp(planRun.startedAt) },
						{ label: "Ended", value: formatTimestamp(planRun.endedAt) },
					]}
				/>
				<details className="text-sm">
					<summary className="cursor-pointer text-(--color-text-2)">Technical details</summary>
					<div className="mt-3">
						<Facts
							rows={[
								{ label: "Attempt ID", value: planRun.id },
								{ label: "Tracker plan", value: planRun.planId ?? "Issues list" },
								{ label: "Agent", value: planRun.agentName },
								{ label: "Model", value: planRun.modelOverride ?? "Agent default" },
								{ label: "Provider", value: planRun.providerOverride ?? "Agent default" },
								{ label: "Base", value: refLine(planRun.ref, runs) ?? "Project default" },
								{ label: "Started by", value: planRun.dispatcherHandle ?? "Unknown" },
								{ label: "Trigger", value: planRun.trigger },
							]}
						/>
					</div>
				</details>
			</RailCard>
			<RailCard title="Delivery">
				{delivered.length === 0 ? (
					<p className="text-(--color-text-2) text-sm">No pull requests have been recorded yet.</p>
				) : (
					delivered.map((pr) => (
						<div key={pr.url} className="flex flex-wrap justify-between gap-2 text-sm">
							<a
								className="wrap-anywhere text-(--color-primary) hover:underline"
								href={pr.url}
								target="_blank"
								rel="noreferrer noopener"
							>
								{pr.label}
							</a>
							<span className={pr.tone}>{pr.stateLabel}</span>
						</div>
					))
				)}
			</RailCard>
			{planRun.promptTemplate !== undefined ? (
				<details className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4 text-sm">
					<summary className="cursor-pointer font-medium">Plan instructions</summary>
					<pre className="wrap-anywhere mt-3 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-(--color-text-2) text-xs">
						{planRun.promptTemplate}
					</pre>
				</details>
			) : null}
		</aside>
	);
}

function RailCard({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
			<h2 className="font-semibold text-base">{title}</h2>
			{children}
		</section>
	);
}

function Facts({ rows }: { rows: readonly { label: string; value: string }[] }) {
	return (
		<dl className="space-y-3">
			{rows.map((row) => (
				<div key={row.label}>
					<dt className="text-(--color-text-2) text-xs">{row.label}</dt>
					<dd className="wrap-anywhere mt-1 text-sm">{row.value}</dd>
				</div>
			))}
		</dl>
	);
}

interface DeliveredPr {
	url: string;
	label: string;
	stateLabel: string;
	tone: string;
}

/**
 * The Delivery card: one entry per child run that reaped a PR, in walk
 * order. Labels carry only facts the merge watcher reported — `merged`,
 * `open`, `closed` — never a fabricated check status.
 */
function collectDeliveredPrs(
	children: PlanRunDetailResponse["children"],
	runs: RunRow[],
): DeliveredPr[] {
	const byId = new Map<string, RunRow>();
	for (const r of runs) byId.set(r.id, r);
	const out: DeliveredPr[] = [];
	for (const c of children) {
		const run = c.runId !== null ? byId.get(c.runId) : undefined;
		const url = run?.prUrl;
		if (url === undefined || url === null) continue;
		out.push({
			url,
			label: prLabel(url),
			stateLabel: prStateLabel(c, run),
			tone: c.state === "merged" ? "text-(--color-success)" : "text-(--color-warning)",
		});
	}
	return out;
}

/** `PR #612` from the forge URL tail; the raw URL when it doesn't parse. */
function prLabel(url: string): string {
	const num = url.match(/\/pull\/(\d+)$/);
	return num === null ? url : `PR #${num[1]}`;
}

/** Merge-watcher facts only: `merged <ts>`, else the forge PR lifecycle. */
function prStateLabel(
	child: PlanRunDetailResponse["children"][number],
	run: RunRow | undefined,
): string {
	if (child.state === "merged") {
		return child.prMergedAt !== null ? `merged ${formatTimestamp(child.prMergedAt)}` : "merged";
	}
	return run?.prState ?? "open";
}

/** `main @ 3f9a1c2`-style ref line from the dispatch ref + a child's base pin. */
function refLine(ref: string | null, runs: readonly RunRow[]): string | null {
	const base = runs.find((r) => r.baseCommit !== null)?.baseCommit;
	if (base !== undefined && base !== null) {
		const short = base.length > 7 ? base.slice(0, 7) : base;
		return `${ref ?? "default"} @ ${short}`;
	}
	return ref;
}
