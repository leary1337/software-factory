import { and, eq } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";

/** Operator settings survive clone refreshes. Revision prevents lost concurrent edits. */
export class ProjectSettingsRepo {
	constructor(private readonly adapter: DrizzleAdapter) {}
	private get db(): SqliteDrizzleDb {
		return this.adapter.drizzle as SqliteDrizzleDb;
	}
	private get table() {
		return this.adapter.schema.projectSettings;
	}

	async get(projectId: string) {
		return (
			(await this.adapter.pickOne(
				this.db.select().from(this.table).where(eq(this.table.projectId, projectId)),
			)) ?? null
		);
	}

	async compareAndSet(
		projectId: string,
		expectedRevision: number,
		settings: Record<string, unknown>,
	): Promise<boolean> {
		const row = {
			projectId,
			settings,
			revision: expectedRevision + 1,
			updatedAt: new Date().toISOString(),
		};
		const rows =
			expectedRevision === 0
				? await this.adapter.runReturningAll(
						this.db.insert(this.table).values(row).onConflictDoNothing().returning(),
					)
				: await this.adapter.runReturningAll(
						this.db
							.update(this.table)
							.set(row)
							.where(
								and(eq(this.table.projectId, projectId), eq(this.table.revision, expectedRevision)),
							)
							.returning(),
					);
		return rows.length === 1;
	}
}
