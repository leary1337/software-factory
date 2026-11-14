import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/** Serialize processes using one workspace cache; a killed indexer cannot strand the cache. */
export async function withGraphLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
	const lock = join(root, "lock");
	const deadline = Date.now() + 125_000;
	while (true) {
		try {
			await mkdir(lock);
			break;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			const owner = await readFile(join(lock, "owner"), "utf8").catch(() => "");
			const pid = Number(owner);
			if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) {
				await rm(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() >= deadline)
				throw new Error("Local graph index is busy; retry after the active query");
			await Bun.sleep(100);
		}
	}
	await writeFile(join(lock, "owner"), String(process.pid));
	try {
		return await operation();
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}
