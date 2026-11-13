import type { RunRow } from "@/api/types.ts";
import {
	CardFigure,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { stateCellOf, sublineOf } from "@/pages/runs/runs-card.helpers.ts";
import { formatDuration, projectLabel } from "@/pages/runs/runs-format.ts";

function RunCard({ row, projectName, now }: { row: RunRow; projectName: string; now: number }) {
	const state = stateCellOf(row);
	return (
		<InventoryRowCard
			tone={state.tone}
			stateLabel={state.label}
			title={row.id}
			titleTo={`/runs/${encodeURIComponent(row.id)}`}
			subline={sublineOf(row, projectName)}
			figures={<CardFigure value={formatDuration(row, now)} />}
		/>
	);
}

export function RunsCardList({
	rows,
	projectIndex,
	now,
}: {
	rows: readonly RunRow[];
	projectIndex: Map<string, string>;
	now: number;
}) {
	return (
		<InventoryCardList>
			{rows.map((row) => (
				<RunCard
					key={row.id}
					now={now}
					row={row}
					projectName={
						row.projectId === null
							? "deleted project"
							: projectLabel(projectIndex.get(row.projectId), row.projectId)
					}
				/>
			))}
		</InventoryCardList>
	);
}
