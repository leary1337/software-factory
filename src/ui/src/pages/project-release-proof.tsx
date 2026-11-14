import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/api/client.ts";
import type { PlanRunDetailResponse } from "@/api/types.ts";
import { hasVerifiedRelease } from "./tasks/task-evidence.ts";

export function ProjectReleaseProof({
	projectId,
	plans,
}: {
	projectId: string;
	plans: PlanRunDetailResponse[];
}) {
	const deploy = useQuery({
		queryKey: ["project-deploy", projectId],
		queryFn: ({ signal }) => projectsApi.deployOverview(projectId, signal),
		retry: false,
	});
	const proofs = plans
		.flatMap((plan) =>
			plan.children
				.filter(hasVerifiedRelease)
				.flatMap((child) => (child.productionVerification ? [child.productionVerification] : [])),
		)
		.sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt));
	const current = deploy.data?.configured ? deploy.data.current : null;
	const verified =
		deploy.data?.configured &&
		deploy.data.currentState !== "unknown" &&
		!deploy.isError &&
		!deploy.data.error
			? proofs.find(
					(proof) =>
						proof.sha === current?.sha &&
						proof.environment === (deploy.data?.configured ? deploy.data.environment : ""),
				)
			: undefined;
	return (
		<div className="space-y-1 border-(--color-border) border-b pb-3 text-sm">
			<p className="font-medium">
				{verified
					? `Current release verified · ${verified.sha.slice(0, 8)}`
					: "Current release not verified"}
			</p>
			{proofs[0] && !verified ? (
				<p className="text-(--color-text-2)">
					Last recorded verification: {proofs[0].sha.slice(0, 8)} · {proofs[0].environment}
				</p>
			) : null}
			<p className="text-(--color-text-2)">
				{verified
					? `Version and user scenario checked at ${new Date(verified.verifiedAt).toLocaleString()}.`
					: "A successful merge or deployment workflow alone does not verify the published application."}
			</p>
		</div>
	);
}
