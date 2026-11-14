import { and, eq } from "drizzle-orm";
import type { PlanEffectKind, PlanEffectState } from "../../core/plan-approval.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

export interface EffectIntent {
	identity: string;
	planRunId: string;
	seq: number;
	kind: PlanEffectKind;
	target: string;
}
export class PlanEffectsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}
	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}
	private get table() {
		return this.adapter.schema.planEffects;
	}
	async get(identity: string) {
		return (
			(await this.adapter.pickOne(
				this.db.select().from(this.table).where(eq(this.table.identity, identity)),
			)) ?? null
		);
	}
	async list(planRunId: string, seq?: number) {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.table)
				.where(
					and(
						eq(this.table.planRunId, planRunId),
						seq === undefined ? undefined : eq(this.table.seq, seq),
					),
				),
		);
	}
	async claim(intent: EffectIntent): Promise<boolean> {
		const now = new Date().toISOString();
		const rows = await this.adapter.runReturningAll(
			this.db
				.insert(this.table)
				.values({ ...intent, state: "intended", createdAt: now, updatedAt: now })
				.onConflictDoNothing()
				.returning(),
		);
		return rows.length === 1;
	}
	async record(
		identity: string,
		state: PlanEffectState,
		result: Record<string, unknown> | null,
		reason: string | null = null,
	) {
		await this.adapter.runWrite(
			this.db
				.update(this.table)
				.set({ state, result, reason, updatedAt: new Date().toISOString() })
				.where(eq(this.table.identity, identity)),
		);
	}
}
