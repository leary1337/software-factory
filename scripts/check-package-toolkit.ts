import { spawnSync } from "node:child_process";

export function missingToolkitFiles(files: readonly string[]): string[] {
	const required = [
		"factory/skill-pack/catalog.json",
		"factory/skill-pack/LOCK.json",
		"factory/toolkit/catalog.json",
		"factory/template/gitignore.template",
		"factory/template/web/bun.lock",
		"src/toolkit/graphify-mcp.ts",
		"src/sandbox/process-guardian.ts",
	];
	return required.filter((path) => !files.includes(path));
}

if (import.meta.main) {
	const packed = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		encoding: "utf8",
	});
	if (packed.status !== 0) throw new Error("Cannot inspect package contents");
	const manifest = JSON.parse(packed.stdout) as { files: { path: string }[] }[];
	const missing = missingToolkitFiles(manifest[0]?.files.map((file) => file.path) ?? []);
	if (missing.length)
		throw new Error(`Package is missing the shared toolkit: ${missing.join(", ")}`);
	console.log("Package includes shared skills, MCP catalog and executable wrappers");
}
