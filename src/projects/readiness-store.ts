import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectReadiness } from "../core/readiness.ts";

function path(directory: string, id: string) {
	return join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
}
export async function readReadiness(
	directory: string,
	id: string,
): Promise<ProjectReadiness | null> {
	try {
		return JSON.parse(await readFile(path(directory, id), "utf8")) as ProjectReadiness;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function saveReadiness(
	directory: string,
	id: string,
	proof: ProjectReadiness,
): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const target = path(directory, id);
	const temp = `${target}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(proof), { mode: 0o600 });
		await rename(temp, target);
	} finally {
		await rm(temp, { force: true });
	}
}
export function readinessFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
