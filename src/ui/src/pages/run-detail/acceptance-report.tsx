import type { ReviewSummary } from "@/api/review-types.ts";

export function AcceptanceReport({ acceptance }: { acceptance: ReviewSummary["acceptance"] }) {
	if (!acceptance) return null;
	return (
		<section className="mt-4 space-y-3" aria-label="Acceptance evidence">
			<h3 className="font-semibold text-sm">Acceptance evidence</h3>
			<p className="text-xs">
				{acceptance.verified
					? "Runtime checks verified"
					: "Some acceptance criteria remain unverified"}{" "}
				· {acceptance.enforced ? "Required for merge" : "Informational"}
			</p>
			{acceptance.criteria.map((entry) => (
				<article
					key={`${entry.checkId}-${entry.criterion}`}
					className="space-y-2 rounded border border-(--color-border) p-3 text-sm"
				>
					<div className="flex flex-wrap justify-between gap-2">
						<h4 className="break-words font-medium">{entry.criterion}</h4>
						<span>{entry.result === "NOT_RUN" ? "Not verified" : entry.result}</span>
					</div>
					{entry.reason ? <p className="break-words">{entry.reason}</p> : null}
					{entry.command ? <p className="break-all font-mono text-xs">{entry.command}</p> : null}
					<p className="break-all text-xs">
						Commit: {entry.commit} {entry.browser ? "· Browser check" : ""}
					</p>
					{entry.artifacts.map((artifact) => (
						<details key={artifact.path} className="min-w-0">
							<summary className="cursor-pointer break-all">
								{artifact.path} · {artifact.bytes} bytes
							</summary>
							<p className="break-all font-mono text-xs">SHA-256: {artifact.sha256}</p>
							{artifact.imageDataUrl ? (
								<img
									src={artifact.imageDataUrl}
									alt={`Browser evidence for ${entry.criterion}`}
									className="mt-2 max-w-full rounded"
								/>
							) : null}
							{artifact.text !== null ? (
								<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
									{artifact.text}
								</pre>
							) : null}
						</details>
					))}
				</article>
			))}
		</section>
	);
}
