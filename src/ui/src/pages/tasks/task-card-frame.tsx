import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { TaskStatus } from "./task-status.ts";
import { TaskStatusMessage } from "./task-status-message.tsx";

export function TaskCardFrame({
	project,
	title,
	description,
	status,
	href,
	children,
}: {
	project: string;
	title: string;
	description: string;
	status: TaskStatus;
	href: string;
	children?: ReactNode;
}) {
	return (
		<article className="min-w-0 space-y-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
			<div className="flex flex-wrap justify-between gap-2 text-(--color-text-2) text-xs">
				<span className="break-all">{project}</span>
				<span>{status.label}</span>
			</div>
			<h3 className="break-words font-semibold text-base">
				<Link className="hover:underline" to={href}>
					{title}
				</Link>
			</h3>
			<p className="wrap-anywhere whitespace-pre-line text-(--color-text-2) text-sm">
				{description}
			</p>
			<TaskStatusMessage status={status} />
			{children}
			<Link to={href} className="inline-block font-medium text-(--color-primary) text-sm">
				Open task →
			</Link>
		</article>
	);
}
