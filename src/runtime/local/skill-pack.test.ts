import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SKILL_PACK_DIR, materializeSkillPack, pstackPluginDir } from "./skill-pack.ts";

const temps: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "skill-pack-"));
	temps.push(dir);
	return dir;
}

function write(root: string, path: string, body: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("materializeSkillPack", () => {
	test("puts each part of the pack where claude looks for it", async () => {
		const pack = tempDir();
		const home = tempDir();
		write(pack, "pstack/skills/swarm/SKILL.md", "swarm");
		write(pack, "mattpocock/skills/tdd/SKILL.md", "tdd");
		write(pack, "factory/skills/go-best-practices/SKILL.md", "go");
		write(pack, "rules/pstack-models.md", "models");

		await materializeSkillPack(home, pack);

		expect(readFileSync(join(pstackPluginDir(home), "skills/swarm/SKILL.md"), "utf8")).toBe(
			"swarm",
		);
		expect(readFileSync(join(home, ".claude/skills/tdd/SKILL.md"), "utf8")).toBe("tdd");
		expect(readFileSync(join(home, ".claude/skills/go-best-practices/SKILL.md"), "utf8")).toBe(
			"go",
		);
		expect(readFileSync(join(home, ".claude/rules/pstack-models.md"), "utf8")).toBe("models");
	});

	test("rejects when the pack is missing", async () => {
		await expect(materializeSkillPack(tempDir(), join(tempDir(), "nope"))).rejects.toThrow();
	});
});

describe("the committed pack", () => {
	test("holds the pinned plugin and every locked skill", () => {
		const lock = JSON.parse(readFileSync(join(DEFAULT_SKILL_PACK_DIR, "LOCK.json"), "utf8"));
		expect(existsSync(join(DEFAULT_SKILL_PACK_DIR, "pstack/.claude-plugin/plugin.json"))).toBe(
			true,
		);
		for (const skill of lock.mattpocock.skills) {
			expect(existsSync(join(DEFAULT_SKILL_PACK_DIR, "mattpocock/skills", skill, "SKILL.md"))).toBe(
				true,
			);
		}
	});
});
