import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { formatError } from "@/lib/format-error.ts";
import { cn, relativeTime } from "@/lib/utils.ts";

const PANEL =
	"flex min-w-0 flex-col rounded-xl border border-(--color-border) bg-(--color-surface)";
const PANEL_HEAD =
	"flex min-h-10 shrink-0 flex-wrap items-center gap-2.5 border-b border-b-(--color-border) px-3.5 py-2";
const MONO = "font-mono text-xs leading-4";
const NOTE = "font-mono text-xs leading-4 text-(--color-text-3)";

function behindLabel(overview: ProjectDeployOverview): string {
	if (overview.currentState === "unknown") return "Текущий Release неизвестен";
	if (overview.current === null) return "Ещё не опубликовано";
	if (overview.behind === null) return "Нет данных";
	if (overview.behind.count === 0) return "Deployed";
	return `Ready to deploy · ${overview.behind.count} commits`;
}

function releaseLabel(overview: ProjectDeployOverview): string {
	const { current, currentState, environment } = overview;
	if (currentState === "unknown") return "Не удалось определить опубликованный Release.";
	return current === null
		? `В ${environment} пока нет Release`
		: `Release ${current.sha.slice(0, 7)} · ${relativeTime(current.createdAt)}`;
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
						Будет запущен {overview.workflow} в GitHub Actions для актуального commit ветки{" "}
						{overview.branch}. Сейчас: {overview.candidateSha?.slice(0, 7) ?? "SHA неизвестен"}.
					</DialogDescription>
				</DialogHeader>
				{overview.activePlan !== null ? (
					<Alert className="text-(--color-fg)" variant="warning">
						План ещё выполняется: Merged {overview.activePlan.merged} из {overview.activePlan.total}
						. Этот Deploy опубликует промежуточный результат.
					</Alert>
				) : null}
				<ChangeList overview={overview} />
				{error ? <p className="text-(--color-destructive) text-sm">{formatError(error)}</p> : null}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Отмена
					</Button>
					<Button onClick={onConfirm} disabled={pending}>
						{pending ? "Запускается…" : "Deploy"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ReleaseHistory({ overview }: { overview: ProjectDeployOverview }) {
	const { history } = overview;
	return (
		<details open>
			<summary className="cursor-pointer text-sm">Состав Release и история</summary>
			<div className="mt-3 space-y-3">
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
		</details>
	);
}

function Overview({
	overview,
	onDeploy,
	compact,
	requested,
}: {
	overview: ProjectDeployOverview;
	onDeploy: () => void;
	compact: boolean;
	requested: boolean;
}) {
	const { activeRun, error } = overview;
	return (
		<div className="flex flex-col gap-3 p-3">
			{error !== null ? (
				<Alert className="text-(--color-fg)" variant="warning">
					{error}
				</Alert>
			) : null}
			<div className={cn("flex items-center justify-between gap-3", !compact && "flex-wrap")}>
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className={cn("font-semibold leading-5", compact ? "text-xs" : "text-sm")}>
						{behindLabel(overview)}
					</span>
					<span className="text-(--color-text-2) text-xs">{releaseLabel(overview)}</span>
					{!compact ? (
						<span className="text-(--color-text-3) text-xs">
							Следующий Release · {overview.candidateSha?.slice(0, 7) ?? "SHA неизвестен"} ·{" "}
							{overview.branch}
						</span>
					) : null}
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
					<OperatorOnly capability="dispatch">
						<Button
							size={compact ? "sm" : "default"}
							className="shrink-0"
							onClick={onDeploy}
							disabled={
								requested ||
								overview.behind?.count === 0 ||
								overview.currentState === "unknown" ||
								error !== null
							}
						>
							{requested ? "Deploy запрошен…" : "Deploy"}
						</Button>
					</OperatorOnly>
				)}
			</div>
			{!compact && activeRun === null && overview.latestRun?.status === "completed" ? (
				<a
					className={`${MONO} text-(--color-primary)`}
					href={overview.latestRun.url}
					target="_blank"
					rel="noreferrer"
				>
					Workflow · {overview.latestRun.conclusion ?? "completed"} ↗
				</a>
			) : null}
			{!compact ? <ReleaseHistory overview={overview} /> : null}
		</div>
	);
}

export function DeployPanel({
	projectId,
	title = "Production",
	compact = false,
}: {
	projectId: string;
	title?: string;
	compact?: boolean;
}) {
	const qc = useQueryClient();
	const caps = useCapabilities();
	const [requested, setRequested] = useState<{ previousRunId: number | null } | null>(null);
	const [confirming, setConfirming] = useState(false);
	const queryKey = ["project-deploy", projectId];
	const overview = useQuery({
		queryKey,
		enabled: caps.can("readOperator"),
		queryFn: ({ signal }) => projectsApi.deployOverview(projectId, signal),
		retry: false,
		refetchInterval: (q) => {
			const data = q.state.data;
			return requested || (data?.configured && data.activeRun !== null) ? 10_000 : 60_000;
		},
	});
	const deploy = useMutation({
		mutationFn: async () => {
			const previousRunId = overview.data?.configured
				? (overview.data.latestRun?.id ?? null)
				: null;
			await projectsApi.startDeploy(projectId);
			return { previousRunId };
		},
		onSuccess: (request) => {
			setConfirming(false);
			setRequested(request);
			void qc.invalidateQueries({ queryKey });
		},
	});

	const data = overview.data;
	useEffect(() => {
		if (!requested || !data?.configured) return;
		if (data.activeRun || (data.latestRun && data.latestRun.id !== requested.previousRunId))
			setRequested(null);
	}, [data, requested]);
	return (
		<OperatorOnly capability="readOperator">
			<section className={PANEL} aria-label="Production">
				<div className={PANEL_HEAD}>
					<h2 className="font-semibold text-(--color-text) text-sm leading-5">{title}</h2>
					{data?.configured && !compact ? (
						<span className={`${NOTE} break-all`}>
							{data.environment} · {data.workflow}
						</span>
					) : null}
				</div>
				{overview.isError ? (
					<div className="flex flex-col items-start gap-3 p-3.5">
						<Alert className="text-(--color-fg)" variant="warning">
							Не удалось загрузить Production: {formatError(overview.error)}
						</Alert>
						<Button
							variant="outline"
							onClick={() => void overview.refetch()}
							disabled={overview.isFetching}
						>
							Повторить
						</Button>
					</div>
				) : null}
				{data === undefined && !overview.isError ? (
					<p role="status" className="p-3.5 text-sm">
						Загрузка Production…
					</p>
				) : null}
				{data !== undefined && !data.configured && !overview.isError ? (
					<p className="p-3.5 text-(--color-text-3) text-sm">
						Deploy для этого проекта не настроен.
					</p>
				) : null}
				{data?.configured && !overview.isError ? (
					<>
						<Overview
							overview={data}
							compact={compact}
							requested={requested !== null}
							onDeploy={() => setConfirming(true)}
						/>
						<ConfirmDeploy
							overview={data}
							open={confirming}
							onOpenChange={setConfirming}
							onConfirm={() => deploy.mutate()}
							pending={deploy.isPending}
							error={deploy.error}
						/>
					</>
				) : null}
			</section>
		</OperatorOnly>
	);
}
