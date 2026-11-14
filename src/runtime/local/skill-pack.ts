/**
 * The factory skill pack: one versioned catalog for supported harnesses,
 * delivered into the run's own $HOME so skills never touch the git
 * worktree. See `factory/skill-pack/LOCK.json` for the upstream commits.
 */

import { join } from "node:path";
import { DEFAULT_SKILL_PACK_DIR } from "./skill-catalog.ts";
import { installSkillCatalog } from "./skill-install.ts";

export { DEFAULT_SKILL_PACK_DIR } from "./skill-catalog.ts";

/** Where pstack lands in a run's home; `claude --plugin-dir` points here. */
export function pstackPluginDir(homePath: string): string {
	return join(homePath, ".claude", "factory", "pstack");
}

/** Copy the pack into `homePath`. Throws when the pack is missing or unreadable. */
export async function materializeSkillPack(
	homePath: string,
	packDir: string = DEFAULT_SKILL_PACK_DIR,
	browserCliVersion?: string,
): Promise<void> {
	await installSkillCatalog({
		homePath,
		packDir,
		browserCliVersion,
		format: "claude",
		audience: "factory",
		apply: true,
	});
}

/** Codex discovers skills under ~/.agents; pstack references keep a stable root. */
export async function materializeCodexSkillPack(
	homePath: string,
	packDir = DEFAULT_SKILL_PACK_DIR,
	browserCliVersion?: string,
): Promise<void> {
	await installSkillCatalog({
		homePath,
		packDir,
		browserCliVersion,
		format: "agents",
		audience: "factory",
		apply: true,
	});
}
