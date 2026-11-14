import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { ToolkitStatus, ToolkitVersionInfo } from "../core/wire.ts";
import { withFileLock } from "../locks/file-lock.ts";
import { DEFAULT_SKILL_PACK_DIR, loadSkillCatalog } from "../runtime/local/skill-catalog.ts";
import { CatalogSchema, TOOLKIT, type ToolkitBundle, type ToolkitCatalog } from "./catalog.ts";

const Version = z.string().regex(/^[a-f0-9]{64}$/);
const Manifest = z.object({
	version: Version,
	skillsVersion: Version,
	files: z.record(z.string(), Version),
	createdAt: z.string(),
});
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
export type PublishedToolkit = ToolkitVersionInfo;

export function toolkitStoreRoot(): string {
	return join(process.env.WARREN_DATA_DIR ?? join(homedir(), ".warren", "data"), "toolkits");
}

export const toolkitUpdateLock = () => join(toolkitStoreRoot(), "update.flock");

export function resolveToolkitBundle(version: string): ToolkitBundle {
	Version.parse(version);
	const root = join(toolkitStoreRoot(), "versions", version);
	const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
	if (manifest.version !== version) throw new Error("Toolkit manifest version mismatch");
	if (
		hash(JSON.stringify({ skillsVersion: manifest.skillsVersion, files: manifest.files })) !==
		version
	)
		throw new Error("Toolkit content does not match its version");
	for (const [file, expected] of Object.entries(manifest.files)) {
		if (basename(file) !== file || hash(readFileSync(join(root, file), "utf8")) !== expected)
			throw new Error("Pinned toolkit artifact changed");
	}
	return {
		root,
		catalog: CatalogSchema.parse(JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"))),
	};
}

export async function toolkitSkillPack(version?: string): Promise<string> {
	if (!version) return DEFAULT_SKILL_PACK_DIR;
	const { root } = resolveToolkitBundle(version);
	const manifest = Manifest.parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
	const path = join(root, "skills");
	if ((await loadSkillCatalog(path)).version !== manifest.skillsVersion)
		throw new Error("Pinned skills changed after approval");
	return path;
}

/** Materialize a new immutable candidate; active plans keep their prior version directory. */
export async function publishToolkitVersion(
	catalog: ToolkitCatalog = TOOLKIT,
): Promise<PublishedToolkit> {
	const skills = await loadSkillCatalog();
	const build = await Bun.build({
		entrypoints: [
			resolve(import.meta.dir, "graphify-mcp.ts"),
			resolve(import.meta.dir, "../sandbox/process-guardian.ts"),
		],
		target: "bun",
		naming: "[name].ts",
		minify: false,
	});
	if (!build.success) throw new Error("Toolkit executable build failed");
	const contents = Object.fromEntries(
		await Promise.all(
			build.outputs.map(async (file) => [basename(file.path), await file.text()] as const),
		),
	);
	contents["catalog.json"] = `${JSON.stringify(CatalogSchema.parse(catalog), null, 2)}\n`;
	const files = Object.fromEntries(
		Object.entries(contents).map(([name, body]) => [name, hash(body)]),
	);
	const version = hash(JSON.stringify({ skillsVersion: skills.version, files }));
	const root = join(toolkitStoreRoot(), "versions", version);
	if (existsSync(join(root, "manifest.json"))) {
		resolveToolkitBundle(version);
		return Manifest.parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
	}
	const temporary = `${root}.${crypto.randomUUID()}`;
	await mkdir(temporary, { recursive: true, mode: 0o700 });
	const manifest = {
		version,
		skillsVersion: skills.version,
		files,
		createdAt: new Date().toISOString(),
	};
	try {
		await cp(DEFAULT_SKILL_PACK_DIR, join(temporary, "skills"), { recursive: true });
		if ((await loadSkillCatalog(join(temporary, "skills"))).version !== skills.version)
			throw new Error("Skills changed while publishing toolkit");
		for (const [name, body] of Object.entries(contents))
			await writeFile(join(temporary, name), body);
		await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		try {
			await rename(temporary, root);
		} catch (error) {
			if (!existsSync(join(root, "manifest.json"))) throw error;
			resolveToolkitBundle(version);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return manifest;
}

export async function activateToolkitVersion(version: string): Promise<void> {
	await toolkitSkillPack(version);
	const path = join(toolkitStoreRoot(), "active.json");
	const temporary = `${path}.${crypto.randomUUID()}`;
	await writeFile(temporary, `${JSON.stringify({ version })}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

async function readActiveVersion(): Promise<string | undefined> {
	const path = join(toolkitStoreRoot(), "active.json");
	if (!existsSync(path)) return undefined;
	const { version } = z
		.object({ version: Version })
		.parse(JSON.parse(await readFile(path, "utf8")));
	resolveToolkitBundle(version);
	return version;
}
export async function activeToolkitVersion(): Promise<string> {
	const current = await readActiveVersion();
	if (current) return current;
	return withFileLock(toolkitUpdateLock(), async () => {
		const installed = await readActiveVersion();
		if (installed) return installed;
		const candidate = await publishToolkitVersion();
		await activateToolkitVersion(candidate.version);
		return candidate.version;
	});
}

export async function toolkitStatus(): Promise<ToolkitStatus> {
	const activeVersion = await activeToolkitVersion();
	const root = join(toolkitStoreRoot(), "versions");
	const versions: ToolkitVersionInfo[] = [];
	for (const directory of await readdir(root)) {
		if (!Version.safeParse(directory).success) continue;
		try {
			const { root: path } = resolveToolkitBundle(directory);
			await toolkitSkillPack(directory);
			const manifest = Manifest.parse(
				JSON.parse(await readFile(join(path, "manifest.json"), "utf8")),
			);
			versions.push({
				version: manifest.version,
				skillsVersion: manifest.skillsVersion,
				createdAt: manifest.createdAt,
			});
		} catch {}
	}
	return {
		activeVersion,
		versions: versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
	};
}
