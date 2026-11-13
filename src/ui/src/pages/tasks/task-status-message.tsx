import type { TaskStatus } from "./task-status.ts";

/** One reason/action presentation for the task card and its detail callout. */
export function TaskStatusMessage({ status }: { status: TaskStatus }) {
	return (
		<div className="space-y-2 text-sm">
			{status.detail ? <p className="wrap-anywhere">{status.detail}</p> : null}
			{status.paths?.length ? (
				<div>
					<p className="font-medium">Files requiring review</p>
					<ul className="mt-1 list-inside list-disc space-y-1">
						{status.paths.map((path) => (
							<li key={path} className="wrap-anywhere">
								{path}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{status.action !== status.detail ? (
				<p className="wrap-anywhere text-(--color-text-2)">{status.action}</p>
			) : null}
		</div>
	);
}
