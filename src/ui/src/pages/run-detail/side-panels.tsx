import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import type { DispatchRouteState } from "@/pages/dispatch/dispatch-draft.ts";
import { formatTokens } from "@/pages/run-detail-format.ts";
import { shortSha } from "@/pages/runs/runs-format.ts";
import { formatRunElapsed, readRescueFacts } from "./run-detail-format.ts";

function PanelShell({
	title,
	trailing,
	children,
}: {
	title: string;
	trailing?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="flex shrink-0 flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[39px] shrink-0 items-center border-(--color-border) border-b px-3">
				<h2 className="font-semibold text-(--color-text) text-xs leading-4">{title}</h2>
				{trailing !== undefined ? <span className="flex-1" /> : null}
				{trailing}
			</header>
			<div className="flex flex-col gap-2 p-3">{children}</div>
		</section>
	);
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
	// Mobile (warren-ecd8): 82px label + 10px values below md — at 375px the
	// desktop 104px label leaves ~207px for values like anthropic/claude-sonnet-4-6.
	return (
		<div className="flex gap-2.5">
			<span className="w-[82px] shrink-0 text-(--color-text-3) text-xs leading-4 md:w-[104px]">
				{label}
			</span>
			<span className="min-w-0 flex-1 break-words font-mono text-(--color-text-2) text-xs leading-4 md:text-xs">
				{children}
			</span>
		</div>
	);
}

const DASH = <span className="text-(--color-text-3)">—</span>;

/**
 * #1241 (warren-1db0): the salvage rescue block on the Runtime panel — the
 * rescue branch, the durable bundle path, the copy-ready re-dispatch command,
 * and (operators only) a button that navigates to Dispatch with the run's
 * `rescueFromRunId` pre-filled. Renders nothing for unsalvaged runs.
 */
function RescueRows({ run }: { run: RunRow }) {
	const navigate = useNavigate();
	const rescue = readRescueFacts(run);
	if (rescue === null) return null;
	return (
		<div className="flex flex-col gap-2 border-(--color-border) border-t pt-2">
			<MetaRow label="rescue">{rescue.ref}</MetaRow>
			{rescue.bundlePath !== null ? (
				<MetaRow label="rescue bundle">{rescue.bundlePath}</MetaRow>
			) : null}
			<p className="font-mono text-(--color-text-3) text-xs leading-4">{rescue.hint}</p>
			<OperatorOnly>
				<button
					type="button"
					className="self-start rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface) px-[11px] py-1 font-medium text-(--color-text) text-xs leading-4 hover:bg-(--color-surface-hover)"
					onClick={() =>
						navigate("/dispatch", {
							state: {
								rescueFromRunId: run.id,
								agent: run.agentName,
								...(run.projectId !== null ? { project: run.projectId } : {}),
								prompt: run.prompt,
							} satisfies DispatchRouteState,
						})
					}
				>
					Dispatch from rescue
				</button>
			</OperatorOnly>
		</div>
	);
}

export function RuntimePanel({ run }: { run: RunRow }) {
	const handle = run.sandboxRunId ?? run.sandboxId ?? null;
	const workspaceBranch = run.branch ?? run.targetBranch ?? run.ref;
	const showTarget = run.targetBranch !== null && run.targetBranch !== workspaceBranch;
	return (
		<PanelShell
			title="Runtime"
			trailing={
				<span className="font-mono text-(--color-text-3) text-xs leading-4">
					{relativeTime(run.endedAt ?? run.startedAt)}
				</span>
			}
		>
			<MetaRow label="provider">{run.provider ?? DASH}</MetaRow>
			<MetaRow label="sandbox">
				{handle !== null && handle.length > 0
					? handle
					: run.state === "queued"
						? "not scheduled"
						: DASH}
			</MetaRow>
			<MetaRow label="base commit">
				{run.baseSha !== null ? (
					shortSha(run.baseSha)
				) : run.baseCommit !== null ? (
					// warren-b19e: the pin is a fallback — the dispatch-time cut
					// point, not the resolved base the diff was measured against.
					<span>
						{shortSha(run.baseCommit)} <span className="text-(--color-text-3)">base pin</span>
					</span>
				) : (
					DASH
				)}
			</MetaRow>
			<MetaRow label="branch">{workspaceBranch ?? DASH}</MetaRow>
			{showTarget ? <MetaRow label="target">{run.targetBranch}</MetaRow> : null}
			<RescueRows run={run} />
		</PanelShell>
	);
}

export function TokensPanel({ run }: { run: RunRow }) {
	return (
		<PanelShell title="Tokens">
			<MetaRow label="tokens in">
				{run.tokensInput !== null ? formatTokens(run.tokensInput) : DASH}
			</MetaRow>
			<MetaRow label="tokens out">
				{run.tokensOutput !== null ? formatTokens(run.tokensOutput) : DASH}
			</MetaRow>
			<MetaRow label="cache read">
				{run.tokensCacheRead !== null ? formatTokens(run.tokensCacheRead) : DASH}
			</MetaRow>
			<MetaRow label="cache write">
				{run.tokensCacheWrite !== null ? formatTokens(run.tokensCacheWrite) : DASH}
			</MetaRow>
		</PanelShell>
	);
}

export function RunDefinitionPanel({ run, projectName }: { run: RunRow; projectName: string }) {
	return (
		<PanelShell title="Run definition">
			<MetaRow label="agent">{run.agentName}</MetaRow>
			<MetaRow label="provider">{run.provider ?? DASH}</MetaRow>
			<MetaRow label="model">{run.model ?? DASH}</MetaRow>
			<MetaRow label="project">{projectName}</MetaRow>
			<MetaRow label="trigger">{run.trigger}</MetaRow>
			<MetaRow label="tracker">{run.seedId ?? "no tracker item"}</MetaRow>
			<MetaRow label="started">{formatTimestamp(run.startedAt)}</MetaRow>
			<MetaRow label="elapsed">{formatRunElapsed(run, Date.now())}</MetaRow>
			{run.parentRunId !== null ? (
				<MetaRow
					label={
						run.cloneKind === "replicate"
							? "re-run of"
							: run.cloneKind === "rescue"
								? "rescued from"
								: "continued from"
					}
				>
					{run.parentRunId}
				</MetaRow>
			) : null}
			{run.retryOf !== null ? <MetaRow label="retry of">{run.retryOf}</MetaRow> : null}
		</PanelShell>
	);
}

export function PromptPanel({ run }: { run: RunRow }) {
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void navigator.clipboard.writeText(run.prompt).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		});
	};
	return (
		<PanelShell
			title="Prompt"
			trailing={
				<button
					type="button"
					onClick={copy}
					className="font-medium text-(--color-text-2) text-xs leading-4 hover:text-(--color-text)"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			}
		>
			<p className="max-h-[240px] overflow-auto break-words font-mono text-(--color-text-2) text-xs leading-4">
				{run.prompt}
			</p>
		</PanelShell>
	);
}
