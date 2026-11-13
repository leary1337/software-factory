/* ----------------------------------------------------------------------- */
/* Ops overview wire types (pl-7e38 step 13 / warren-d903; split out of    */
/* types.ts under the file-size budget, same pattern as                    */
/* run-analytics-types.ts).                                                */
/* ----------------------------------------------------------------------- */

import type { OpsWindow, RunState } from "../../../core/wire.ts";

export interface OpsOverviewResponse {
	readonly runs: {
		readonly byState: Readonly<Partial<Record<RunState, number>>>;
		readonly nonTerminal: number;
		readonly total: number;
	};

	readonly window: OpsWindow;
	readonly delivery?: {
		readonly branchesPushed: number;
		readonly prsOpened: number;
		readonly prsMerged: number;
	};
	readonly services?: {
		readonly dbReachable: boolean;
		readonly runtime: string;
		readonly lifecycleStream: boolean;
	};
	readonly generatedAt: string;
}
