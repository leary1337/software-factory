#!/usr/bin/env bun
/** Restore the separately installed UI dependencies on a fresh checkout. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function needsUiDependencies(root: string): boolean {
	return (
		existsSync(resolve(root, "src/ui/package.json")) &&
		!existsSync(resolve(root, "src/ui/node_modules"))
	);
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	if (needsUiDependencies(root)) {
		console.error("Installing UI dependencies for the workspace checks.");
		const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
			cwd: resolve(root, "src/ui"),
			stdio: "inherit",
		});
		process.exitCode = result.status ?? 1;
	}
}
