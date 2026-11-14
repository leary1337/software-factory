import { createHash } from "node:crypto";
import { readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Hash private artifacts without placing their content in a report. */
export async function snapshotFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const target = join(path, entry.name);
			if (entry.isDirectory()) {
				await walk(target);
				continue;
			}
			const name = relative(root, target);
			if (
				["backup-manifest.json", "restore-queue-disabled.json", "activation-pending.json"].includes(
					name,
				)
			)
				continue;
			if (entry.isSymbolicLink()) files[name] = `link:${await readlink(target)}`;
			else if (entry.isFile())
				files[name] = createHash("sha256")
					.update(await readFile(target))
					.digest("hex");
			else
				throw new Error(
					"Installation contains a nonportable socket or device; stop its services before backup",
				);
		}
	}
	await walk(root);
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function referenceFile(name: string, path: string) {
	return (
		[".git", "alternates", "config", "gitdir", "commondir"].includes(name) ||
		path.includes("/manifests/")
	);
}
export async function relocateFiles(
	root: string,
	replacements: ReadonlyArray<readonly [string, string]>,
) {
	async function walk(path: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const target = join(path, entry.name);
			if (entry.isDirectory()) {
				await walk(target);
				continue;
			}
			if (!entry.isFile() || !referenceFile(entry.name, target)) continue;
			if ((await stat(target)).size > 2_000_000) continue;
			const content = await readFile(target, "utf8");
			const updated = replacements.reduce(
				(text, [before, after]) => text.replaceAll(before, after),
				content,
			);
			if (content !== updated) await writeFile(target, updated);
		}
	}
	await walk(root);
}
