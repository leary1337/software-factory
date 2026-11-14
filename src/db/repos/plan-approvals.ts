import { and, asc, desc, eq } from "drizzle-orm";
import { NotFoundError, StateTransitionError, ValidationError } from "../../core/errors.ts";
import type { PlanApproval } from "../../core/plan-approval.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/** Immutable decisions; only the initial start links an approval to its plan run. */
export class PlanApprovalsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}
	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}
	private get table() {
		return this.adapter.schema.planApprovals;
	}
	async get(id: string): Promise<PlanApproval | null> {
		return (
			(await this.adapter.pickOne(
				this.db.select().from(this.table).where(eq(this.table.id, id)),
			)) ?? null
		);
	}
	async require(id: string): Promise<PlanApproval> {
		const row = await this.get(id);
		if (!row) throw new NotFoundError(`Approved plan not found: ${id}`);
		return row;
	}
	async byCommand(commandKey: string): Promise<PlanApproval | null> {
		return (
			(await this.adapter.pickOne(
				this.db.select().from(this.table).where(eq(this.table.commandKey, commandKey)),
			)) ?? null
		);
	}
	async save(row: PlanApproval): Promise<PlanApproval> {
		await this.adapter.runWrite(
			this.db
				.insert(this.table)
				.values({ ...row, projectId: row.snapshot.projectId })
				.onConflictDoNothing(),
		);
		const stored = await this.byCommand(row.commandKey);
		if (!stored || stored.digest !== row.digest)
			throw new ValidationError("This command key already names a different approved plan.");
		return stored;
	}
	async applyRevision(row: PlanApproval, expectedRevision: number): Promise<PlanApproval> {
		if (!row.planRunId) throw new ValidationError("Revision requires a running plan");
		const planRunId = row.planRunId;
		return this.adapter.runInTransaction(async (tx) => {
			const db = tx.drizzle as SqliteDrizzleDb;
			const latest = await tx.pickOne(
				db
					.select()
					.from(tx.schema.planApprovals)
					.where(eq(tx.schema.planApprovals.planRunId, planRunId))
					.orderBy(desc(tx.schema.planApprovals.revision))
					.limit(1),
			);
			if (latest?.revision !== expectedRevision)
				throw new StateTransitionError("Plan revision changed");
			const children = await tx.pickAll(
				db
					.select()
					.from(tx.schema.planRunChildren)
					.where(eq(tx.schema.planRunChildren.planRunId, planRunId)),
			);
			await tx.runWrite(
				db.insert(tx.schema.planApprovals).values({ ...row, projectId: row.snapshot.projectId }),
			);
			for (const child of children) {
				if (child.state !== "pending") continue;
				const task = row.snapshot.tasks.find((task) => task.seq === child.seq);
				await tx.runWrite(
					db
						.update(tx.schema.planRunChildren)
						.set(
							task
								? { seedId: task.id }
								: {
										state: "skipped",
										endedAt: row.createdAt,
										failureReason: `Removed by approved revision ${row.revision}`,
									},
						)
						.where(
							and(
								eq(tx.schema.planRunChildren.planRunId, planRunId),
								eq(tx.schema.planRunChildren.seq, child.seq),
							),
						),
				);
			}
			for (const task of row.snapshot.tasks) {
				if (children.some((child) => child.seq === task.seq)) continue;
				await tx.runWrite(
					db.insert(tx.schema.planRunChildren).values({
						planRunId,
						seq: task.seq,
						seedId: task.id,
						state: "pending",
						createdAt: row.createdAt,
						updatedAt: row.createdAt,
						retryCount: 0,
					}),
				);
			}
			return row;
		});
	}

	async history(planRunId: string): Promise<PlanApproval[]> {
		return this.adapter.pickAll(
			this.db
				.select()
				.from(this.table)
				.where(eq(this.table.planRunId, planRunId))
				.orderBy(desc(this.table.revision)),
		);
	}
	async forRun(planRunId: string): Promise<PlanApproval | null> {
		return (await this.history(planRunId))[0] ?? null;
	}
}

/** Used inside the plan-run creation transaction, before any queue rows are written. */
export async function existingApprovalExecution(
	tx: DrizzleAdapter,
	approvalId: string | undefined,
	projectId: string,
) {
	if (!approvalId) return null;
	const txDb = tx.drizzle as SqliteDrizzleDb;
	const approval = await tx.pickOne(
		txDb.select().from(tx.schema.planApprovals).where(eq(tx.schema.planApprovals.id, approvalId)),
	);
	if (!approval || approval.projectId !== projectId)
		throw new ValidationError("Approved plan does not match the project");
	if (!approval.planRunId) return null;
	const existing = await tx.pickOne(
		txDb.select().from(tx.schema.planRuns).where(eq(tx.schema.planRuns.id, approval.planRunId)),
	);
	if (!existing) throw new StateTransitionError("Approved plan has a missing execution record");
	const children = await tx.pickAll(
		txDb
			.select()
			.from(tx.schema.planRunChildren)
			.where(eq(tx.schema.planRunChildren.planRunId, existing.id))
			.orderBy(asc(tx.schema.planRunChildren.seq)),
	);
	return { planRun: existing, children };
}
