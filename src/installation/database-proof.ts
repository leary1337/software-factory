import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface DatabaseProof {
	digest: string;
	migrationHashes: string[];
	tables: Record<string, number>;
}
/** Read-only evidence covers queue, history, effect receipts, and schema compatibility. */
export function databaseProof(path: string): DatabaseProof {
	const db = new Database(path, { readonly: true });
	try {
		if (
			db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !==
			"ok"
		)
			throw new Error("Database integrity check failed");
		const tables: Record<string, number> = {};
		const digest = createHash("sha256");
		const names = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all();
		for (const { name } of names) {
			const quoted = `"${name.replaceAll('"', '""')}"`;
			const rows = db
				.query(`SELECT * FROM ${quoted}`)
				.all()
				.map((row) => JSON.stringify(row))
				.sort();
			tables[name] = rows.length;
			digest.update(name);
			for (const row of rows) digest.update(row);
		}
		const migrationHashes = db
			.query<{ hash: string }, []>("SELECT hash FROM __drizzle_migrations ORDER BY id")
			.all()
			.map((row) => row.hash);
		return { digest: digest.digest("hex"), migrationHashes, tables };
	} finally {
		db.close();
	}
}

export function assertCompatibleDatabase(proof: Pick<DatabaseProof, "migrationHashes">): void {
	const folder = new URL("../db/migrations/", import.meta.url).pathname;
	const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
		entries: { tag: string }[];
	};
	const hashes = journal.entries.map((entry) =>
		createHash("sha256")
			.update(readFileSync(join(folder, `${entry.tag}.sql`)))
			.digest("hex"),
	);
	// Legacy hand-authored migrations may predate Drizzle tracking; compare the recorded suffix.
	const last = proof.migrationHashes.at(-1);
	if (!last || !hashes.includes(last) || proof.migrationHashes.length > hashes.length)
		throw new Error(
			"Backup schema is incompatible with this factory version. Use a matching or newer verified version",
		);
}

/** Boot checks the migration journal without hashing an entire historical database. */
export function assertCompatibleDatabaseFile(path: string): void {
	const db = new Database(path, { readonly: true });
	try {
		if (!db.query("SELECT name FROM sqlite_master WHERE name = '__drizzle_migrations'").get())
			return;
		const hashes = db
			.query<{ hash: string }, []>("SELECT hash FROM __drizzle_migrations ORDER BY id")
			.all()
			.map((row) => row.hash);
		if (hashes.length) assertCompatibleDatabase({ migrationHashes: hashes });
	} finally {
		db.close();
	}
}
