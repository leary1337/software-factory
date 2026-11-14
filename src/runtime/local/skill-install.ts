import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { TOOLKIT } from "../../toolkit/catalog.ts";
import {
	fileFingerprint,
	isRelativePath,
	loadSkillCatalog,
	projectSkillCatalog,
	type SkillAudience,
	type SkillFile,
	type SkillFormat,
} from "./skill-catalog.ts";

const ManifestSchema = z.object({
	schemaVersion: z.literal(1),
	version: z.string().regex(/^[a-f0-9]{64}$/),
	format: z.enum(["agents", "claude"]),
	audience: z.enum(["personal", "factory"]),
	files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

export interface InstallSkillsOptions {
	readonly homePath: string;
	readonly format: SkillFormat;
	readonly audience: SkillAudience;
	readonly packDir?: string;
	readonly browserCliVersion?: string;
	readonly apply?: boolean;
}

export interface SkillInstallReport {
	readonly version: string;
	readonly format: SkillFormat;
	readonly audience: SkillAudience;
	readonly applied: boolean;
	readonly writes: readonly string[];
	readonly removals: readonly string[];
	readonly conflicts: readonly string[];
	readonly borrowed: readonly string[];
	readonly unchanged: number;
}

function rootName(format: SkillFormat): string {
	return format === "agents" ? ".agents" : ".claude";
}

function isManagedPath(path: string, format: SkillFormat): boolean {
	const root = rootName(format);
	const plugin = format === "agents" ? `${root}/pstack/` : `${root}/factory/pstack/`;
	return (
		isRelativePath(path) &&
		(path.startsWith(`${root}/skills/`) ||
			path.startsWith(plugin) ||
			path.startsWith(`${root}/rules/`) ||
			path === `${root}/FACTORY-SKILLS.md`)
	);
}

async function statIfExists(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertNoLinks(root: string, path: string): Promise<void> {
	let current = root;
	for (const segment of path.split("/")) {
		current = join(current, segment);
		const stat = await statIfExists(current);
		if (stat?.isSymbolicLink()) throw new Error(`Skill destination contains a symlink: ${path}`);
	}
}

async function currentFingerprint(root: string, path: string): Promise<string | undefined> {
	await assertNoLinks(root, path);
	const file = join(root, path);
	const stat = await statIfExists(file);
	if (stat === undefined) return undefined;
	if (!stat.isFile()) throw new Error(`Skill destination is not a regular file: ${path}`);
	return fileFingerprint({ body: await readFile(file), mode: stat.mode & 0o777 });
}

async function previousFiles(
	root: string,
	manifestPath: string,
	format: SkillFormat,
): Promise<Record<string, string>> {
	await assertNoLinks(root, manifestPath);
	if (!(await statIfExists(join(root, manifestPath)))) return {};
	const manifest = ManifestSchema.parse(
		JSON.parse(await readFile(join(root, manifestPath), "utf8")),
	);
	if (manifest.format !== format) throw new Error("Skill manifest format does not match target");
	for (const path of Object.keys(manifest.files)) {
		if (!isManagedPath(path, format)) throw new Error(`Invalid managed skill path: ${path}`);
	}
	return manifest.files;
}

async function inspectRemovals(
	root: string,
	wanted: ReadonlySet<string>,
	previous: Record<string, string>,
) {
	const removals: string[] = [];
	const conflicts: string[] = [];
	for (const path of Object.keys(previous).filter((name) => !wanted.has(name))) {
		const current = await currentFingerprint(root, path);
		if (current === undefined) continue;
		if (current === previous[path]) removals.push(path);
		else conflicts.push(path);
	}
	return { removals, conflicts };
}

async function inspectChanges(
	root: string,
	files: readonly SkillFile[],
	previous: Record<string, string>,
) {
	const writes: SkillFile[] = [];
	const borrowed: string[] = [];
	const wanted = new Set(files.map((file) => file.path));
	const { removals, conflicts } = await inspectRemovals(root, wanted, previous);
	let unchanged = 0;
	for (const file of files) {
		const current = await currentFingerprint(root, file.path);
		if (current === fileFingerprint(file)) {
			unchanged++;
			if (previous[file.path] === undefined) borrowed.push(file.path);
		} else if (current === undefined || current === previous[file.path]) writes.push(file);
		else conflicts.push(file.path);
	}
	return { writes, removals, conflicts, borrowed, unchanged };
}

async function atomicWrite(root: string, file: SkillFile): Promise<void> {
	await assertNoLinks(root, file.path);
	const target = join(root, file.path);
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.factory-${crypto.randomUUID()}`;
	try {
		await writeFile(temp, file.body, { flag: "wx", mode: file.mode });
		await chmod(temp, file.mode);
		await rename(temp, target);
	} finally {
		await rm(temp, { force: true });
	}
}

async function install(options: InstallSkillsOptions): Promise<SkillInstallReport> {
	const root = resolve(options.homePath);
	const catalog = await loadSkillCatalog(options.packDir);
	const files = projectSkillCatalog(catalog, options.format, options.audience);
	const cliVersion = z
		.string()
		.regex(/^\d+\.\d+\.\d+$/)
		.parse(options.browserCliVersion ?? TOOLKIT.playwright.cliVersion);
	for (const skill of files.filter((file) => file.path.endsWith("/browser-checks/SKILL.md"))) {
		files.push({
			path: skill.path.replace(/SKILL\.md$/, "PINNED-CLI.md"),
			mode: 0o644,
			body: Buffer.from(
				`# Pinned Playwright CLI\n\nRun \`npx -y @playwright/cli@${cliVersion} --help\` for this toolkit's CLI syntax.\nKeep this version for every CLI command in the task.\n`,
			),
		});
	}
	const manifestPath = `${rootName(options.format)}/factory-skills.json`;
	const previous = await previousFiles(root, manifestPath, options.format);
	const changes = await inspectChanges(root, files, previous);
	const report = {
		version: catalog.version,
		format: options.format,
		audience: options.audience,
		applied: options.apply === true,
		writes: changes.writes.map((file) => file.path),
		removals: changes.removals,
		conflicts: changes.conflicts,
		borrowed: changes.borrowed,
		unchanged: changes.unchanged,
	};
	if (!options.apply) return report;
	if (changes.conflicts.length)
		throw new Error(
			`Skill installation conflicts with existing files: ${changes.conflicts.join(", ")}`,
		);
	for (const file of changes.writes) await atomicWrite(root, file);
	for (const path of changes.removals) {
		await assertNoLinks(root, path);
		await rm(join(root, path));
	}
	const manifest = {
		schemaVersion: 1,
		version: catalog.version,
		format: options.format,
		audience: options.audience,
		sources: catalog.sources,
		skills: catalog.skills.map(({ name, source, audiences }) => ({ name, source, audiences })),
		files: Object.fromEntries(
			files
				.filter((file) => !changes.borrowed.includes(file.path))
				.map((file) => [file.path, fileFingerprint(file)]),
		),
	};
	const receipt = {
		path: manifestPath,
		body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
		mode: 0o600,
	};
	if ((await currentFingerprint(root, manifestPath)) !== fileFingerprint(receipt)) {
		await atomicWrite(root, receipt);
	}
	return report;
}

/** Inspect by default; explicit apply owns only unchanged files from its prior receipt. */
export async function installSkillCatalog(
	options: InstallSkillsOptions,
): Promise<SkillInstallReport> {
	if (!options.apply) return install(options);
	const root = resolve(options.homePath);
	const state = rootName(options.format);
	await assertNoLinks(root, state);
	await mkdir(join(root, state), { recursive: true });
	const lockPath = join(root, state, ".factory-skills-lock");
	await mkdir(lockPath);
	try {
		return await install(options);
	} finally {
		await rm(lockPath, { recursive: true, force: true });
	}
}
