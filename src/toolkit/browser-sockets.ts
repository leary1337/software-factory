import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";

/** macOS Unix sockets cannot fit beneath a long per-run HOME path. */
export function browserSocketDirectory(home = homedir()): string {
	return `/tmp/fpw-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
}

export async function prepareBrowserSockets(home: string): Promise<() => Promise<void>> {
	const path = browserSocketDirectory(home);
	await mkdir(path, { recursive: true, mode: 0o700 });
	return () => rm(path, { recursive: true, force: true });
}
