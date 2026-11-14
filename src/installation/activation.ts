import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { snapshotFiles } from "./snapshot-files.ts";

const PENDING = "activation-pending.json";
interface ActivationIntent {
	stage: string;
	before: Record<string, string>;
	after: Record<string, string>;
}

/** Prepare relocated bytes elsewhere; every later replacement is atomic and replayable. */
export async function applyActivation(
	root: string,
	prepare: (stage: string) => Promise<void>,
	afterWrite?: () => void,
) {
	const intentPath = join(root, PENDING);
	let intent: ActivationIntent;
	if (existsSync(intentPath)) {
		intent = JSON.parse(await readFile(intentPath, "utf8")) as ActivationIntent;
		if (resolve(intent.stage) !== intent.stage || !intent.stage.startsWith(`${root}.activation-`))
			throw new Error("Activation recovery state is invalid");
	} else {
		const stage = `${root}.activation-${randomUUID()}`;
		await cp(root, stage, { recursive: true, dereference: false, preserveTimestamps: true });
		await chmod(stage, 0o700);
		const before = await snapshotFiles(root);
		await prepare(stage);
		intent = { stage, before, after: await snapshotFiles(stage) };
		const temporary = `${intentPath}.tmp`;
		await writeFile(temporary, JSON.stringify(intent), { mode: 0o600 });
		await rename(temporary, intentPath);
	}
	for (const path of Object.keys(intent.after))
		await rm(`${join(root, path)}.${basename(intent.stage)}.tmp`, { force: true });
	const current = await snapshotFiles(root);
	for (const [path, hash] of Object.entries(current)) {
		if (hash !== intent.before[path] && hash !== intent.after[path])
			throw new Error(
				"Installation changed outside its pending activation; preserve the copy and inspect it",
			);
	}
	if (JSON.stringify(await snapshotFiles(intent.stage)) !== JSON.stringify(intent.after))
		throw new Error("Activation staging copy is damaged");
	for (const [path, hash] of Object.entries(intent.after)) {
		if (current[path] === hash) continue;
		const source = join(intent.stage, path),
			target = join(root, path);
		const temporary = `${target}.${basename(intent.stage)}.tmp`;
		await writeFile(temporary, await readFile(source), { mode: (await stat(source)).mode & 0o777 });
		await rename(temporary, target);
		afterWrite?.();
	}
	return async () => {
		await rm(intentPath);
		await rm(intent.stage, { recursive: true, force: true });
	};
}

export function hasPendingActivation(root: string): boolean {
	return existsSync(join(root, PENDING));
}
