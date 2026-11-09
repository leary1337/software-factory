import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { projectsApi } from "@/api/client.ts";
import type { ProjectDeployOverview } from "@/api/deploy-types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";

const PANEL =
	"flex min-w-0 flex-col rounded-sm border border-(--color-border) bg-(--color-surface)";
const PANEL_HEAD =
	"flex h-10 shrink-0 items-center gap-2.5 border-b border-b-(--color-border) px-3.5";
const MONO = "font-mono text-xs leading-4";
const NOTE = "font-mono text-xs leading-3 text-(--color-text-3)";

function behindLabel(overview: ProjectDeployOverview): string {
	if (overview.current === null) return "Not deployed yet";
	if (overview.behind === null) return "Unknown";
	if (overview.behind.count === 0) return "Up to date";
	return `Behind by ${overview.behind.count} commit${overview.behind.count === 1 ? "" : "s"}`;
}

function ChangeList({ overview }: { overview: ProjectDeployOverview }) {
	const changes = overview.behind?.changes ?? [];
	if (changes.length === 0) return null;
	return (
		<ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
			{changes.map((change) => (
				<li key={change.sha} className="flex gap-2 text-xs leading-4">
					<span className={`${MONO} shrink-0 text-(--color-text-3)`}>{change.sha.slice(0, 7)}</span>
					<span className="min-w-0 break-words">{change.title}</span>
				</li>
			))}
		</ul>
	);
}

function ConfirmDeploy(props: {
	overview: ProjectDeployOverview;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	pending: boolean;
	error: unknown;
}) {
	const { overview, open, onOpenChange, onConfirm, pending, error } = props;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Deploy {overview.branch} to {overview.environment}?
					</DialogTitle>
					<DialogDescription>
						This starts {overview.workflow} in GitHub Actions. {behindLabel(overview)}.
					</DialogDescription>
				</DialogHeader>
				{overview.activePlan !== null ? (
					<Alert variant="warning">
						A plan is still running: {overview.activePlan.merged} of {overview.activePlan.total}{" "}
						tickets merged. This deploys an in-between state.
					</Alert>
				) : null}
				<ChangeList overview={overview} />
				{error ? <p className="text-(--color-destructive) text-sm">{formatError(error)}</p> : null}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={onConfirm} disabled={pending}>
						{pending ? "Starting…" : "Deploy"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Overview({
	overview,
	onDeploy,
}: {
	overview: ProjectDeployOverview;
	onDeploy: () => void;
}) {
	const { current, activeRun, history, error } = overview;
	return (
		<div className="flex flex-col gap-3 p-3.5">
			{error !== null ? <Alert variant="warning">{error}</Alert> : null}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="font-semibold text-sm leading-5">{behindLabel(overview)}</span>
					<span className={NOTE}>
						{current !== null
							? `live ${current.sha.slice(0, 7)} · ${relativeTime(current.createdAt)}`
							: `nothing live on ${overview.environment} yet`}
					</span>
				</div>
				{activeRun !== null ? (
					<a
						className={`${MONO} text-(--color-primary)`}
						href={activeRun.url}
						target="_blank"
						rel="noreferrer"
					>
						Deploying · {activeRun.status} ↗
					</a>
				) : (
					<Button onClick={onDeploy} disabled={overview.behind?.count === 0}>
						Deploy
					</Button>
				)}
			</div>
			<ChangeList overview={overview} />
			{history.length > 0 ? (
				<ul className="flex flex-col gap-1 border-t border-t-(--color-border) pt-2.5">
					{history.map((deploy) => (
						<li
							key={`${deploy.sha}-${deploy.createdAt}`}
							className={`${NOTE} flex justify-between gap-3`}
						>
							<span>
								{deploy.sha.slice(0, 7)} · {relativeTime(deploy.createdAt)}
							</span>
							<span>{deploy.state}</span>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function DeployPanel({ projectId }: { projectId: string }) {
	const qc = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const queryKey = ["project-deploy", projectId];
	const overview = useQuery({
		queryKey,
		queryFn: ({ signal }) => projectsApi.deployOverview(projectId, signal),
		refetchInterval: (q) => {
			const data = q.state.data;
			return data?.configured && data.activeRun !== null ? 10_000 : 60_000;
		},
	});
	const deploy = useMutation({
		mutationFn: () => projectsApi.startDeploy(projectId),
		onSuccess: () => {
			setConfirming(false);
			void qc.invalidateQueries({ queryKey });
		},
	});

	const data = overview.data;
	if (data === undefined || !data.configured) return null;
	return (
		<OperatorOnly capability="dispatch">
			<section className={PANEL} aria-label="Production">
				<div className={PANEL_HEAD}>
					<h2 className="font-semibold text-(--color-text) text-xs leading-4">Production</h2>
					<span className={NOTE}>
						{data.environment} · {data.workflow}
					</span>
				</div>
				<Overview overview={data} onDeploy={() => setConfirming(true)} />
				<ConfirmDeploy
					overview={data}
					open={confirming}
					onOpenChange={setConfirming}
					onConfirm={() => deploy.mutate()}
					pending={deploy.isPending}
					error={deploy.error}
				/>
			</section>
		</OperatorOnly>
	);
}
