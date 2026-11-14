import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSkillCatalog } from "./skill-catalog.ts";
import { installSkillCatalog } from "./skill-install.ts";

const temps: string[] = [];
function temporary(): string {
	const path = mkdtempSync(join(tmpdir(), "factory-skills-"));
	temps.push(path);
	return path;
}

function write(root: string, path: string, body: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), body);
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8");
}

function fixture() {
	const homePath = temporary();
	const packDir = temporary();
	const config = {
		schemaVersion: 1,
		groups: [
			{ source: "factory", directory: "factory/skills", audiences: ["factory", "personal"] },
			{ source: "owner", directory: "owner/skills", audiences: ["personal"] },
			{ source: "plugin", directory: "plugin/skills", audiences: ["factory", "personal"] },
		],
		overrides: { tdd: "factory" },
		resources: ["pstack/docs", "rules"],
	};
	write(packDir, "catalog.json", JSON.stringify(config));
	write(
		packDir,
		"LOCK.json",
		JSON.stringify(
			Object.fromEntries(
				["owner", "plugin"].map((name) => [
					name,
					{
						repository: `https://example.com/${name}`,
						commit: "a".repeat(40),
					},
				]),
			),
		),
	);
	write(packDir, "factory/skills/tdd/SKILL.md", "---\nname: tdd\n---\nCanonical TDD");
	write(packDir, "factory/skills/tdd/references/example.md", "TDD reference");
	write(packDir, "plugin/skills/tdd/SKILL.md", "Conflicting TDD");
	write(packDir, "owner/skills/grilling/SKILL.md", "Interactive interview");
	write(packDir, "pstack/docs/harness/codex.md", "Harness instructions");
	write(packDir, "rules/models.md", "Model instructions");
	return { homePath, packDir, config, format: "agents" as const, audience: "personal" as const };
}

afterEach(() => {
	for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("installSkillCatalog", () => {
	test("previews without writing then applies once and preserves unrelated settings", async () => {
		const options = fixture();
		write(options.homePath, ".codex/auth.json", "private credentials");
		write(options.homePath, ".claude/settings.json", "personal settings");
		write(options.homePath, ".agents/skills/custom/SKILL.md", "personal skill");
		const preview = await installSkillCatalog(options);
		expect(preview.applied).toBe(false);
		expect(preview.writes).toContain(".agents/skills/tdd/SKILL.md");
		expect(existsSync(join(options.homePath, ".agents/factory-skills.json"))).toBe(false);
		expect(existsSync(join(options.homePath, ".agents/skills/tdd"))).toBe(false);
		const applied = await installSkillCatalog({ ...options, apply: true });
		expect(applied.version).toBe(preview.version);
		const repeat = await installSkillCatalog({ ...options, apply: true });
		expect(repeat.writes).toEqual([]);
		expect(repeat.removals).toEqual([]);
		expect(repeat.conflicts).toEqual([]);
		expect(read(options.homePath, ".codex/auth.json")).toBe("private credentials");
		expect(read(options.homePath, ".claude/settings.json")).toBe("personal settings");
		expect(read(options.homePath, ".agents/skills/custom/SKILL.md")).toBe("personal skill");
		expect(read(options.homePath, ".agents/FACTORY-SKILLS.md")).toContain(applied.version);
	});

	test("shares a version and canonical sources across formats and profiles", async () => {
		const options = fixture();
		const personal = await installSkillCatalog({ ...options, apply: true });
		const factoryHome = temporary();
		const automated = await installSkillCatalog({
			...options,
			homePath: factoryHome,
			audience: "factory",
			apply: true,
		});
		const claudeHome = temporary();
		const claude = await installSkillCatalog({
			...options,
			homePath: claudeHome,
			format: "claude",
			audience: "factory",
			apply: true,
		});
		expect(automated.version).toBe(personal.version);
		expect(claude.version).toBe(personal.version);
		const canonical = read(options.packDir, "factory/skills/tdd/SKILL.md");
		for (const path of [".agents/skills/tdd/SKILL.md", ".agents/pstack/skills/tdd/SKILL.md"]) {
			expect(read(factoryHome, path)).toBe(canonical);
		}
		for (const path of [
			".claude/skills/tdd/SKILL.md",
			".claude/factory/pstack/skills/tdd/SKILL.md",
		]) {
			expect(read(claudeHome, path)).toBe(canonical);
		}
		expect(existsSync(join(options.homePath, ".agents/skills/grilling/SKILL.md"))).toBe(true);
		expect(existsSync(join(factoryHome, ".agents/skills/grilling"))).toBe(false);
		expect(existsSync(join(claudeHome, ".claude/skills/grilling"))).toBe(false);
		expect(read(factoryHome, ".agents/pstack/docs/harness/codex.md")).toContain(
			"no person available",
		);
		expect(read(claudeHome, ".claude/rules/factory-execution.md")).toContain("no person available");
		const manifest = JSON.parse(read(factoryHome, ".agents/factory-skills.json"));
		expect(manifest.version).toBe(personal.version);
		expect(manifest.sources.owner.commit).toBe("a".repeat(40));
		expect(manifest.skills.find((skill: { name: string }) => skill.name === "tdd").source).toBe(
			"factory",
		);
	});

	test("reports a conflicting personal skill and applies nothing", async () => {
		const options = fixture();
		const path = ".agents/skills/tdd/SKILL.md";
		write(options.homePath, path, "User TDD");
		const report = await installSkillCatalog(options);
		expect(report.conflicts).toEqual([path]);
		await expect(installSkillCatalog({ ...options, apply: true })).rejects.toThrow("conflicts");
		expect(read(options.homePath, path)).toBe("User TDD");
		expect(existsSync(join(options.homePath, ".agents/skills/grilling"))).toBe(false);
		expect(existsSync(join(options.homePath, ".agents/factory-skills.json"))).toBe(false);
	});

	test("borrows an identical personal skill without claiming or deleting it", async () => {
		const options = fixture();
		const path = ".agents/skills/grilling/SKILL.md";
		write(options.homePath, path, read(options.packDir, "owner/skills/grilling/SKILL.md"));
		const report = await installSkillCatalog({ ...options, apply: true });
		expect(report.borrowed).toContain(path);
		const receipt = JSON.parse(read(options.homePath, ".agents/factory-skills.json"));
		expect(receipt.files[path]).toBeUndefined();
		await installSkillCatalog({ ...options, audience: "factory", apply: true });
		expect(read(options.homePath, path)).toBe("Interactive interview");
	});

	test("preserves a borrowed factory skill after switching profiles and removing its source", async () => {
		const options = fixture();
		const path = ".agents/skills/tdd/SKILL.md";
		write(options.homePath, path, read(options.packDir, "factory/skills/tdd/SKILL.md"));
		await installSkillCatalog({ ...options, audience: "factory", apply: true });
		await installSkillCatalog({ ...options, audience: "personal", apply: true });
		rmSync(join(options.packDir, "factory/skills/tdd"), { recursive: true });
		rmSync(join(options.packDir, "plugin/skills/tdd"), { recursive: true });
		const report = await installSkillCatalog({ ...options, apply: true });
		expect(report.removals).not.toContain(path);
		expect(read(options.homePath, path)).toContain("Canonical TDD");
	});

	test("updates changed sources and removes only untouched owned files", async () => {
		const options = fixture();
		const before = await installSkillCatalog({ ...options, apply: true });
		write(options.homePath, ".agents/skills/tdd/personal.md", "Keep me");
		write(options.packDir, "factory/skills/tdd/SKILL.md", "Revised TDD");
		rmSync(join(options.packDir, "factory/skills/tdd/references/example.md"));
		const report = await installSkillCatalog({ ...options, apply: true });
		expect(report.version).not.toBe(before.version);
		expect(report.removals).toContain(".agents/skills/tdd/references/example.md");
		expect(existsSync(join(options.homePath, ".agents/skills/tdd/references/example.md"))).toBe(
			false,
		);
		expect(read(options.homePath, ".agents/skills/tdd/SKILL.md")).toBe("Revised TDD");
		expect(read(options.homePath, ".agents/skills/tdd/personal.md")).toBe("Keep me");
	});

	test("refuses deletion of a managed file edited by the user", async () => {
		const options = fixture();
		await installSkillCatalog({ ...options, apply: true });
		const path = ".agents/skills/grilling/SKILL.md";
		write(options.homePath, path, "Personal changes");
		const report = await installSkillCatalog({ ...options, audience: "factory" });
		expect(report.conflicts).toContain(path);
		await expect(
			installSkillCatalog({ ...options, audience: "factory", apply: true }),
		).rejects.toThrow("conflicts");
		expect(read(options.homePath, path)).toBe("Personal changes");
	});

	test("removes personal-only files when selecting the factory profile", async () => {
		const options = fixture();
		await installSkillCatalog({ ...options, apply: true });
		const report = await installSkillCatalog({ ...options, audience: "factory", apply: true });
		expect(report.removals).toContain(".agents/skills/grilling/SKILL.md");
		expect(existsSync(join(options.homePath, ".agents/skills/grilling/SKILL.md"))).toBe(false);
	});

	test("rejects source and destination symlinks", async () => {
		const options = fixture();
		const outside = temporary();
		mkdirSync(join(options.homePath, ".agents"));
		symlinkSync(outside, join(options.homePath, ".agents/skills"));
		await expect(installSkillCatalog({ ...options, apply: true })).rejects.toThrow("symlink");
		expect(existsSync(join(outside, "tdd"))).toBe(false);
		symlinkSync(outside, join(options.packDir, "factory/skills/tdd/private"));
		await expect(loadSkillCatalog(options.packDir)).rejects.toThrow("symlink");
	});

	test.each(["auth.json", "credentials.json", "history.jsonl"])(
		"rejects private source file %s",
		async (name) => {
			const options = fixture();
			write(options.packDir, `factory/skills/tdd/${name}`, "private credentials");
			await expect(installSkillCatalog(options)).rejects.toThrow("private or hidden");
		},
	);

	test("refuses ambiguous sources and unpinned dependencies", async () => {
		const options = fixture();
		write(options.packDir, "catalog.json", JSON.stringify({ ...options.config, overrides: {} }));
		await expect(loadSkillCatalog(options.packDir)).rejects.toThrow("canonical source");
		write(options.packDir, "catalog.json", JSON.stringify(options.config));
		write(options.packDir, "LOCK.json", "{}");
		await expect(loadSkillCatalog(options.packDir)).rejects.toThrow();
	});

	test("rejects a receipt that claims an unrelated credential", async () => {
		const options = fixture();
		await installSkillCatalog({ ...options, apply: true });
		const receiptPath = ".agents/factory-skills.json";
		const receipt = JSON.parse(read(options.homePath, receiptPath));
		receipt.files[".codex/auth.json"] = "a".repeat(64);
		write(options.homePath, receiptPath, JSON.stringify(receipt));
		await expect(installSkillCatalog(options)).rejects.toThrow("Invalid managed skill path");
	});

	test("offers an explicit CLI dry-run and apply against a temporary home", async () => {
		const options = fixture();
		const args = [
			process.execPath,
			"--env-file=/dev/null",
			"scripts/factory-skills.ts",
			"--home",
			options.homePath,
			"--format",
			"agents",
			"--pack",
			options.packDir,
		];
		const preview = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		expect(await preview.exited).toBe(0);
		expect(JSON.parse(await new Response(preview.stdout).text()).applied).toBe(false);
		expect(existsSync(join(options.homePath, ".agents"))).toBe(false);
		const apply = Bun.spawn([...args, "--apply"], { stdout: "pipe", stderr: "pipe" });
		expect(await apply.exited).toBe(0);
		expect(JSON.parse(await new Response(apply.stdout).text()).applied).toBe(true);
		expect(existsSync(join(options.homePath, ".agents/factory-skills.json"))).toBe(true);
	});
});
