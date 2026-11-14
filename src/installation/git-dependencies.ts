import { existsSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

function below(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
/** Worktrees and object alternates can live outside both the data root and the checkout. */
export async function archiveGitDependencies(
	dataRoot: string,
	stage: string,
	projects: string[],
	roots: Record<string, string>,
): Promise<void> {
	const mappings = () =>
		[[dataRoot, ""], ...Object.entries(roots)].sort(
			([a], [b]) => (b?.length ?? 0) - (a?.length ?? 0),
		);
	const copied = (path: string) => {
		const mapping = mappings().find(([old]) => old !== undefined && below(old, path));
		return mapping?.[0] !== undefined && mapping[1] !== undefined
			? join(stage, mapping[1], relative(mapping[0], path))
			: undefined;
	};
	const archive = async (path: string) => {
		if (copied(path)) return;
		const target = join("imported-git", String(Object.keys(roots).length));
		await cp(path, join(stage, target), {
			recursive: true,
			dereference: false,
			preserveTimestamps: true,
		});
		roots[path] = target;
	};

	const objects = new Set<string>();
	for (const project of projects) {
		if (!existsSync(join(project, ".git"))) continue;
		const gitDir = await gitStorage(project, "--absolute-git-dir"),
			common = await gitStorage(project, "--git-common-dir");
		await archive(common);
		await archive(gitDir);
		objects.add(join(common, "objects"));
		const pointer = copied(join(gitDir, "commondir"));
		if (pointer && existsSync(pointer)) await writeFile(pointer, `${common}\n`);
		const checkoutPointer = copied(join(project, ".git"));
		if (gitDir !== join(project, ".git") && checkoutPointer)
			await writeFile(checkoutPointer, `gitdir: ${gitDir}\n`);
	}
	await archiveAlternates(objects, archive, copied);
}

async function gitStorage(path: string, flag: string) {
	const child = Bun.spawn(["git", "-C", path, "rev-parse", "--path-format=absolute", flag], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const result = (await new Response(child.stdout).text()).trim();
	if ((await child.exited) !== 0 || !isAbsolute(result))
		throw new Error("Cannot resolve a project's Git storage for backup");
	return result;
}

async function archiveAlternates(
	objects: Set<string>,
	archive: (path: string) => Promise<void>,
	copied: (path: string) => string | undefined,
) {
	for (const objectRoot of objects) {
		const alternates = join(objectRoot, "info", "alternates");
		if (!existsSync(alternates)) continue;
		const dependencies = (await readFile(alternates, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((path) => resolve(objectRoot, path));
		for (const dependency of dependencies) {
			await archive(dependency);
			objects.add(dependency);
		}
		const target = copied(alternates);
		if (target) await writeFile(target, `${dependencies.join("\n")}\n`);
	}
}
