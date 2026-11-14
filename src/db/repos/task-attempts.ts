import { and, eq } from "drizzle-orm";
import { StateTransitionError } from "../../core/errors.ts";
import type { TaskAttemptKind } from "../../core/plan-approval.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";
export interface TaskAttemptInput {
	key: string;
	planRunId: string;
	seq: number;
	kind: TaskAttemptKind;
	createdAt: string;
}
export class TaskAttemptsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}
	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}
	private get table() {
		return this.adapter.schema.planTaskAttempts;
	}
	async list(planRunId: string, seq: number) {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.table)
				.where(and(eq(this.table.planRunId, planRunId), eq(this.table.seq, seq))),
		);
	}
	async get(key: string) {
		return (
			(await this.adapter.pickOne(
				this.db.select().from(this.table).where(eq(this.table.key, key)),
			)) ?? null
		);
	}
	async forRun(runId: string) {
		return (
			(await this.adapter.pickOne(
				this.db.select().from(this.table).where(eq(this.table.runId, runId)),
			)) ?? null
		);
	}

	async reserve(input: TaskAttemptInput) {
		await this.adapter.runWrite(this.db.insert(this.table).values(input).onConflictDoNothing());
		return this.get(input.key);
	}
	async finish(key: string, endedAt: string) {
		const row = await this.get(key);
		if (!row || row.endedAt !== null) return;
		await this.adapter.runWrite(
			this.db.update(this.table).set({ endedAt }).where(eq(this.table.key, key)),
		);
	}
	async attach(key: string, runId: string) {
		const row = await this.get(key);
		if (!row || (row.runId !== null && row.runId !== runId))
			throw new StateTransitionError("Task attempt already belongs to another run");
		await this.adapter.runWrite(
			this.db.update(this.table).set({ runId }).where(eq(this.table.key, key)),
		);
	}
}
