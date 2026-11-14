import { cpSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const TEMPLATE_DIR = resolve(import.meta.dir, "../../factory/template");
export function fillPlaceholders(text: string, project: string, module: string): string {
	return text.replaceAll("__PROJECT__", project).replaceAll("__MODULE__", module);
}
function walkFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walkFiles(path) : [path];
	});
}
/** The shipped template is explicit; unsupported stacks are never substituted. */
export function scaffold(dir: string, project: string, module: string): void {
	cpSync(TEMPLATE_DIR, dir, { recursive: true });
	renameSync(join(dir, "gitignore.template"), join(dir, ".gitignore"));
	for (const file of walkFiles(dir)) {
		if (file.includes("/node_modules/") || basename(file) === "bun.lock") continue;
		const text = readFileSync(file, "utf8");
		const filled = fillPlaceholders(text, project, module);
		if (filled !== text) writeFileSync(file, filled);
	}
}
