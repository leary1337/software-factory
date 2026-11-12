import { ArrowUpRight, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { cn, relativeTime } from "@/lib/utils.ts";
import type { WorkspaceTask } from "./task-model.ts";

export function WorkspaceTaskCard({
	task,
	project,
	onOpen,
}: {
	task: WorkspaceTask;
	project?: string;
	onOpen: () => void;
}) {
	return (
		<article
			className={cn(
				"min-w-0 rounded-lg border border-(--color-border) bg-(--color-surface) p-4",
				task.attention && "border-(--color-warning)/40",
			)}
		>
			<div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
				<span
					className={cn(
						"flex items-center gap-1.5 text-(--color-text-2)",
						task.attention && "text-(--color-warning)",
					)}
				>
					{task.attention ? <CircleAlert className="h-3.5 w-3.5" /> : null}
					{task.attention ? "Требует тебя" : task.column}
				</span>
				{project ? <span className="min-w-0 truncate text-(--color-text-3)">{project}</span> : null}
			</div>
			<Button
				variant="link"
				onClick={onOpen}
				className="h-auto w-full justify-start whitespace-normal break-words p-0 text-left font-medium text-sm leading-6"
			>
				{task.title}
				<ArrowUpRight className="ml-auto h-4 w-4 shrink-0" />
			</Button>
			{task.attention ? (
				<p className="mt-2 line-clamp-2 break-words text-(--color-text-2) text-sm">{task.reason}</p>
			) : null}
			<div className="mt-3 flex flex-wrap gap-2 text-(--color-text-3) text-xs">
				<span>
					{task.runs.find((r) => r.id === task.runId)?.agentName ??
						task.plan?.current.detail.planRun.agentName ??
						"Ожидает запуска"}
				</span>
				{task.updatedAt ? (
					<span data-visual-mask="">· {relativeTime(new Date(task.updatedAt).toISOString())}</span>
				) : null}
			</div>
		</article>
	);
}
