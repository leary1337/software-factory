import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDatabaseUrl } from "../../db/url.ts";
import { assertCompatibleDatabaseFile } from "../../installation/database-proof.ts";
import { acquireInstallationOwner } from "../../installation/owner.ts";
import type { EnvLike } from "../config.ts";
import { BootCleanup } from "./boot-cleanup.ts";

/** A lease outlives every listener, timer, bridge, and runtime process it protects. */
export async function bootWithInstallationOwner<T extends { stop(): Promise<void> }>(
	env: EnvLike,
	boot: (cleanup: BootCleanup) => Promise<T>,
): Promise<T> {
	const database = parseDatabaseUrl(
		env.WARREN_DB_URL ?? env.WARREN_DB_PATH ?? join(env.WARREN_DATA_DIR ?? "/data", "warren.db"),
	);
	const cleanup = new BootCleanup();
	const lease =
		database.dialect === "sqlite" && database.path === ":memory:"
			? undefined
			: acquireInstallationOwner(env.WARREN_DATA_DIR ?? "/data", {
					databaseKey: database.dialect === "sqlite" ? database.path : database.connectionString,
				});
	try {
		if (database.dialect === "sqlite" && database.path !== ":memory:" && existsSync(database.path))
			assertCompatibleDatabaseFile(database.path);
		const handle = await boot(cleanup);
		return {
			...handle,
			stop: async () => {
				await handle.stop();
				lease?.release();
			},
		};
	} catch (error) {
		await cleanup.stop();
		lease?.release();
		throw error;
	}
}
