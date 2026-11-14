import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { waitForSandboxStop } from "../../../sandbox/guarded-process.ts";
import type { SandboxProfile, SpawnCommand, SpawnResult } from "../../../sandbox/types.ts";
import { runHostProcess } from "../process-spawn.ts";

/** Separate markers let restart recovery wait for every preview writer, not only the agent. */
export async function spawnPreviewProcess(
	profile: SandboxProfile,
	command: SpawnCommand,
): Promise<SpawnResult> {
	const directory = `${profile.home}.sidecars`;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lifecyclePath = join(directory, `${crypto.randomUUID()}.json`);
	const proc = await runHostProcess(profile, command, { lifecyclePath });
	return {
		...proc,
		exited: proc.exited.finally(() => rm(lifecyclePath, { force: true })),
	};
}

export async function waitForPreviewProcesses(home: string): Promise<void> {
	const directory = `${home}.sidecars`;
	let markers: string[];
	try {
		markers = await readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await Promise.all(markers.map((marker) => waitForSandboxStop(join(directory, marker))));
	await rm(directory, { recursive: true, force: true });
}
