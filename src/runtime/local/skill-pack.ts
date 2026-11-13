/**
 * The factory skill pack: pinned copies of the skills every claude-code run
 * gets, delivered into the run's own $HOME so they never touch the git
 * worktree. See `factory/skill-pack/LOCK.json` for the upstream commits.
 */

import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEFAULT_SKILL_PACK_DIR = resolve(import.meta.dir, "../../../factory/skill-pack");

/** Where pstack lands in a run's home; `claude --plugin-dir` points here. */
export function pstackPluginDir(homePath: string): string {
	return join(homePath, ".claude", "factory", "pstack");
}

/** Copy the pack into `homePath`. Throws when the pack is missing or unreadable. */
export async function materializeSkillPack(
	homePath: string,
	packDir: string = DEFAULT_SKILL_PACK_DIR,
): Promise<void> {
	const claudeDir = join(homePath, ".claude");
	await cp(join(packDir, "pstack"), pstackPluginDir(homePath), { recursive: true });
	await cp(join(packDir, "mattpocock", "skills"), join(claudeDir, "skills"), { recursive: true });
	await cp(join(packDir, "factory", "skills"), join(claudeDir, "skills"), { recursive: true });
	await cp(join(packDir, "rules"), join(claudeDir, "rules"), { recursive: true });
}

/** Codex discovers skills under ~/.agents; pstack references keep a stable root. */
export async function materializeCodexSkillPack(
	homePath: string,
	packDir = DEFAULT_SKILL_PACK_DIR,
): Promise<void> {
	const skills = join(homePath, ".agents", "skills");
	await cp(join(packDir, "mattpocock", "skills"), skills, { recursive: true });
	await cp(join(packDir, "factory", "skills"), skills, { recursive: true });
	await cp(join(packDir, "pstack"), join(homePath, ".agents", "pstack"), { recursive: true });
}
