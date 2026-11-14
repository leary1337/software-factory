import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toolkitApi } from "@/api/client.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";

export function ToolkitSettings() {
	const cache = useQueryClient();
	const status = useQuery({
		queryKey: ["toolkit"],
		queryFn: ({ signal }) => toolkitApi.status(signal),
	});
	const check = useMutation({ mutationFn: () => toolkitApi.check() });
	const [applied, setApplied] = useState<string>();
	const apply = useMutation({
		mutationFn: (version: string) => toolkitApi.apply(version),
		onSuccess: (data) => {
			cache.setQueryData(["toolkit"], data);
			setApplied(data.activeVersion);
		},
	});
	return (
		<section
			aria-label="Shared skills and tools"
			className="space-y-4 rounded-xl border border-(--color-border) bg-(--color-surface) p-4"
		>
			<h2 className="font-semibold text-base">Shared skills and tools</h2>
			<p className="text-(--color-text-2) text-sm">
				One version for new work. Running plans keep their approved version.
			</p>
			{status.isPending ? <Spinner label="Loading shared tools" /> : null}
			{status.isError ? (
				<Alert variant="danger" title="Could not load shared tools">
					{formatError(status.error)}
					<Button variant="outline" onClick={() => void status.refetch()}>
						Retry
					</Button>
				</Alert>
			) : null}
			{status.data ? (
				<p className="break-all text-sm">
					Active version: <strong>{status.data.activeVersion}</strong>
				</p>
			) : null}
			<OperatorOnly capability="admin">
				<Button
					variant="outline"
					disabled={check.isPending || apply.isPending}
					onClick={() => check.mutate()}
				>
					{check.isPending ? "Checking…" : "Check available update"}
				</Button>
			</OperatorOnly>
			{check.isError || apply.isError ? (
				<Alert variant="danger" title="Shared tools were not changed">
					{formatError(check.error ?? apply.error)}
				</Alert>
			) : null}
			{check.data ? (
				<div className="space-y-3">
					<p className="break-all text-sm">Checked version: {check.data.candidate.version}</p>
					<ul className="space-y-1 text-sm">
						{check.data.dependencies.map((dependency) => (
							<li key={dependency.name}>
								{dependency.name}: {dependency.available ? "ready" : "unavailable"}
							</li>
						))}
						{check.data.probes.map((probe) => (
							<li key={probe.service}>
								{probe.service}: {probe.status} · {probe.tools.length} tools
							</li>
						))}
					</ul>
					<OperatorOnly capability="admin">
						<Button
							disabled={
								apply.isPending || check.data.candidate.version === status.data?.activeVersion
							}
							onClick={() => {
								if (check.data) apply.mutate(check.data.candidate.version);
							}}
						>
							Apply checked version
						</Button>
					</OperatorOnly>
				</div>
			) : null}
			{applied ? (
				<p role="status" className="break-all text-(--color-success) text-sm">
					Applied version {applied}.
				</p>
			) : null}
			{status.data && status.data.versions.length > 1 ? (
				<details>
					<summary className="cursor-pointer text-sm">Previous versions and rollback</summary>
					<ul className="mt-3 space-y-3">
						{status.data.versions
							.filter((version) => version.version !== status.data.activeVersion)
							.map((version) => (
								<li key={version.version} className="flex flex-wrap items-center gap-3">
									<span className="min-w-0 break-all text-xs">{version.version}</span>
									<OperatorOnly capability="admin">
										<Button
											variant="outline"
											size="sm"
											disabled={apply.isPending}
											onClick={() => apply.mutate(version.version)}
										>
											Use this version
										</Button>
									</OperatorOnly>
								</li>
							))}
					</ul>
				</details>
			) : null}
		</section>
	);
}
