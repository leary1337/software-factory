import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_SKILL_PACK_DIR = resolve(import.meta.dir, "../../../factory/skill-pack");
export type SkillAudience = "personal" | "factory";
export type SkillFormat = "agents" | "claude";
export const FACTORY_SKILL_POLICY =
	"Work from the approved task and repository instructions. The approved acceptance criteria and verification seams replace skill interview and routine confirmation steps. Resolve ordinary implementation choices within that scope. Report a material decision outside that scope as a blocker; this run has no person available for an interview. Never infer authorization for protected changes outside the approved plan.\n";

const SafePath = z.string().refine(isRelativePath, "Expected a relative path without traversal");
const CatalogSchema = z.object({
	schemaVersion: z.literal(1),
	groups: z
		.array(
			z.object({
				source: z.string().regex(/^[a-z][a-z0-9-]*$/),
				directory: SafePath,
				audiences: z.array(z.enum(["personal", "factory"])).min(1),
			}),
		)
		.min(1),
	overrides: z.record(z.string(), z.string()),
	personalOnly: z.array(z.string()).default([]),
	resources: z.array(SafePath),
});

export interface SkillFile {
	readonly path: string;
	readonly body: Buffer;
	readonly mode: number;
}

export interface CatalogSkill {
	readonly name: string;
	readonly source: string;
	readonly directory: string;
	readonly audiences: readonly SkillAudience[];
	readonly files: readonly SkillFile[];
}

export interface SkillCatalog {
	readonly version: string;
	readonly sources: Readonly<Record<string, unknown>>;
	readonly skills: readonly CatalogSkill[];
	readonly resources: readonly SkillFile[];
}

export function isRelativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.includes("\\") &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

export function fileFingerprint(file: Pick<SkillFile, "body" | "mode">): string {
	return createHash("sha256")
		.update(String(file.mode))
		.update("\0")
		.update(file.body)
		.digest("hex");
}

function assertSourceName(path: string): void {
	for (const part of path.split("/")) {
		if (
			["auth.json", "credentials.json", "history.jsonl", "sessions"].includes(part) ||
			(part.startsWith(".") && part !== ".claude-plugin")
		) {
			throw new Error(`Skill catalog contains private or hidden data: ${path}`);
		}
	}
}

async function assertSourcePath(root: string, path: string): Promise<void> {
	let current = root;
	for (const part of path.split("/")) {
		current = join(current, part);
		if ((await lstat(current)).isSymbolicLink())
			throw new Error(`Skill source is a symlink: ${path}`);
	}
}

async function readTree(root: string, path: string): Promise<SkillFile[]> {
	assertSourceName(path);
	await assertSourcePath(root, path);
	const full = join(root, path);
	const stat = await lstat(full);
	if (stat.isFile()) return [{ path, body: await readFile(full), mode: stat.mode & 0o777 }];
	if (!stat.isDirectory()) throw new Error(`Unsupported skill source: ${path}`);
	const files: SkillFile[] = [];
	for (const name of (await readdir(full)).sort())
		files.push(...(await readTree(root, `${path}/${name}`)));
	return files;
}

async function readGroup(
	root: string,
	group: z.infer<typeof CatalogSchema>["groups"][number],
): Promise<CatalogSkill[]> {
	await assertSourcePath(root, group.directory);
	const result: CatalogSkill[] = [];
	for (const name of (await readdir(join(root, group.directory))).sort()) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid skill name: ${name}`);
		const directory = `${group.directory}/${name}`;
		const files = await readTree(root, directory);
		const entry = files.find((file) => file.path === `${directory}/SKILL.md`);
		if (!entry) throw new Error(`Skill has no SKILL.md: ${directory}`);
		const declared = /^name:\s*["']?([^\s"']+)/m.exec(entry.body.toString("utf8"))?.[1];
		if (declared && declared !== name)
			throw new Error(`Skill name differs from directory: ${directory}`);
		result.push({ ...group, name, directory, files });
	}
	return result;
}

function chooseSkills(
	skills: readonly CatalogSkill[],
	overrides: Record<string, string>,
): CatalogSkill[] {
	const groups = new Map<string, CatalogSkill[]>();
	for (const skill of skills) {
		const candidates = groups.get(skill.name) ?? [];
		candidates.push(skill);
		groups.set(skill.name, candidates);
	}
	return [...groups]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, candidates]) => {
			const source = overrides[name];
			if (candidates.length === 1 && source === undefined) return candidates[0] as CatalogSkill;
			const selected = candidates.filter((skill) => skill.source === source);
			if (selected.length !== 1)
				throw new Error(`Skill ${name} needs one explicit canonical source`);
			return selected[0] as CatalogSkill;
		});
}

function validateSources(lock: unknown, sources: readonly string[]): Record<string, unknown> {
	const parsed = z.record(z.string(), z.unknown()).parse(lock);
	for (const source of sources) {
		if (source === "factory") continue;
		z.object({ repository: z.string().url(), commit: z.string().regex(/^[a-f0-9]{40}$/) }).parse(
			parsed[source],
		);
	}
	return parsed;
}

export async function loadSkillCatalog(packDir = DEFAULT_SKILL_PACK_DIR): Promise<SkillCatalog> {
	await assertSourcePath(packDir, "catalog.json");
	await assertSourcePath(packDir, "LOCK.json");
	const configBytes = await readFile(join(packDir, "catalog.json"));
	const lockBytes = await readFile(join(packDir, "LOCK.json"));
	const config = CatalogSchema.parse(JSON.parse(configBytes.toString("utf8")));
	const sources = validateSources(
		JSON.parse(lockBytes.toString("utf8")),
		config.groups.map((g) => g.source),
	);
	const groups = await Promise.all(config.groups.map((group) => readGroup(packDir, group)));
	const selected = chooseSkills(groups.flat(), config.overrides);
	for (const name of config.personalOnly) {
		if (!selected.some((skill) => skill.name === name))
			throw new Error(`Unknown personal skill: ${name}`);
	}
	const skills = selected.map(
		(skill): CatalogSkill =>
			config.personalOnly.includes(skill.name) ? { ...skill, audiences: ["personal"] } : skill,
	);
	const resources = (
		await Promise.all(config.resources.map((path) => readTree(packDir, path)))
	).flat();
	const all = new Map(
		[...groups.flat().flatMap((skill) => skill.files), ...resources].map((file) => [
			file.path,
			file,
		]),
	);
	const hash = createHash("sha256")
		.update("factory-skills-projection-v1\0")
		.update(configBytes)
		.update(lockBytes);
	for (const file of [...all.values()].sort((a, b) => a.path.localeCompare(b.path))) {
		hash.update(file.path).update("\0").update(fileFingerprint(file));
	}
	return { version: hash.digest("hex"), sources, skills, resources };
}

function targetRoots(format: SkillFormat): { base: string; plugin: string } {
	return format === "agents"
		? { base: ".agents", plugin: ".agents/pstack" }
		: { base: ".claude", plugin: ".claude/factory/pstack" };
}

export function projectSkillCatalog(
	catalog: SkillCatalog,
	format: SkillFormat,
	audience: SkillAudience,
): SkillFile[] {
	const { base, plugin } = targetRoots(format);
	const output = new Map<string, SkillFile>();
	const add = (file: SkillFile, path: string) => output.set(path, { ...file, path });
	for (const skill of catalog.skills.filter((entry) => entry.audiences.includes(audience))) {
		for (const file of skill.files) {
			const path = relative(skill.directory, file.path);
			add(file, `${base}/skills/${skill.name}/${path}`);
			// Existing pstack cross-references and Claude's plugin use the same canonical source.
			add(file, `${plugin}/skills/${skill.name}/${path}`);
		}
	}
	for (const file of catalog.resources) {
		if (file.path.startsWith("pstack/")) add(file, `${plugin}/${file.path.slice(7)}`);
		else if (format === "claude") add(file, `${base}/${file.path}`);
	}
	const policy =
		audience === "personal"
			? "Use interactive planning skills with the owner. Select skills relevant to the task.\n"
			: FACTORY_SKILL_POLICY;
	add(
		{
			path: "",
			mode: 0o644,
			body: Buffer.from(
				`# Factory skills\n\nVersion: ${catalog.version}\nProfile: ${audience}\n\n${policy}`,
			),
		},
		`${base}/FACTORY-SKILLS.md`,
	);
	if (format === "claude") {
		add(
			{ path: "", mode: 0o644, body: Buffer.from(`# Factory execution profile\n\n${policy}`) },
			`${base}/rules/factory-execution.md`,
		);
	} else {
		const guidePath = `${plugin}/docs/harness/codex.md`;
		const guide = output.get(guidePath);
		if (guide)
			add({ ...guide, body: Buffer.concat([Buffer.from(`${policy}\n`), guide.body]) }, guidePath);
	}
	return [...output.values()].sort((a, b) => a.path.localeCompare(b.path));
}
