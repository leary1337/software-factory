import type { Command } from "commander";
import { parseDatabaseUrl } from "../../db/url.ts";
import {
	activateInstallation,
	backupInstallation,
	restoreInstallation,
} from "../../installation/backup.ts";
import type { CliContext } from "../output.ts";

/** Offline local administration deliberately shares the server's owner lease. */
export function registerStateCommands(program: Command, context: CliContext): void {
	const group = program
		.command("state")
		.description("copy, restore, and activate a stopped local installation");
	group
		.command("backup")
		.description(
			"create a verified private copy of history, queue, workspaces, and action receipts",
		)
		.requiredOption("--to <directory>", "new backup directory")
		.option("--data-dir <directory>", "installation data directory")
		.action(async (options: { to: string; dataDir?: string }) => {
			const database = context.env.WARREN_DB_URL
				? parseDatabaseUrl(context.env.WARREN_DB_URL)
				: undefined;
			if (database?.dialect === "postgres")
				throw new Error("Local state backup requires SQLite; this installation uses Postgres");
			const result = await backupInstallation({
				dataDir: options.dataDir ?? context.env.WARREN_DATA_DIR ?? "/data",
				destination: options.to,
				databasePath: database?.path ?? context.env.WARREN_DB_PATH,
			});
			context.stdio.stdout.write(`${JSON.stringify(result)}\n`);
		});
	group
		.command("restore")
		.description("verify and restore a copy with its queue disabled")
		.requiredOption("--from <directory>", "verified backup directory")
		.requiredOption("--to <directory>", "new isolated data directory")
		.action(async (options: { from: string; to: string }) => {
			context.stdio.stdout.write(
				`${JSON.stringify(await restoreInstallation({ backup: options.from, destination: options.to }))}\n`,
			);
		});
	group
		.command("activate")
		.description("activate a restored queue after single-owner and newer-action checks")
		.requiredOption("--data-dir <directory>", "restored data directory")
		.option(
			"--allow-source-unavailable",
			"explicitly activate after inspecting receipts when original data is unavailable",
		)
		.action(async (options: { dataDir: string; allowSourceUnavailable?: boolean }) => {
			context.stdio.stdout.write(`${JSON.stringify(await activateInstallation(options))}\n`);
		});
}
