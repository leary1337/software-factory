import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock } from "../locks/file-lock.ts";
import { materializeCodexSkillPack, materializeSkillPack } from "../runtime/local/skill-pack.ts";
import { TOOLKIT } from "./catalog.ts";
import { applyToolkitVersion, enrollPersonalToolkit } from "./distribution.ts";
import {
	activateToolkitVersion,
	activeToolkitVersion,
	publishToolkitVersion,
	resolveToolkitBundle,
	toolkitSkillPack,
	toolkitStatus,
	toolkitUpdateLock,
} from "./versions.ts";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "factory-toolkit-versions-"));
	previous = process.env.WARREN_DATA_DIR;
	process.env.WARREN_DATA_DIR = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.WARREN_DATA_DIR;
	else process.env.WARREN_DATA_DIR = previous;
	await rm(root, { recursive: true, force: true });
});

describe("toolkit versions", () => {
	test("retains pinned artifacts across update and idempotent rollback", async () => {
		const initial = await publishToolkitVersion();
		await activateToolkitVersion(initial.version);
		const bundle = resolveToolkitBundle(initial.version);
		const oldCode = await readFile(join(bundle.root, "graphify-mcp.ts"), "utf8");
		const candidate = await publishToolkitVersion({
			...TOOLKIT,
			playwright: { ...TOOLKIT.playwright, cliVersion: "0.1.23" },
		});
		expect(candidate.version).not.toBe(initial.version);
		expect(await activeToolkitVersion()).toBe(initial.version);
		await applyToolkitVersion(candidate.version);
		expect(await activeToolkitVersion()).toBe(candidate.version);
		expect(
			await readFile(join(resolveToolkitBundle(initial.version).root, "graphify-mcp.ts"), "utf8"),
		).toBe(oldCode);
		await applyToolkitVersion(initial.version);
		await applyToolkitVersion(initial.version);
		expect((await toolkitStatus()).activeVersion).toBe(initial.version);
		expect(await toolkitSkillPack(initial.version)).toBe(join(bundle.root, "skills"));
	}, 30_000);
	test("preserves the working version when candidate artifacts are corrupted", async () => {
		const current = await activeToolkitVersion();
		const candidate = await publishToolkitVersion({
			...TOOLKIT,
			playwright: { ...TOOLKIT.playwright, cliVersion: "0.1.22" },
		});
		const path = join(resolveToolkitBundle(candidate.version).root, "graphify-mcp.ts");
		await writeFile(path, "changed");
		await expect(applyToolkitVersion(candidate.version)).rejects.toThrow("artifact changed");
		expect(
			(await toolkitStatus()).versions.some((item) => item.version === candidate.version),
		).toBe(false);
		expect(await activeToolkitVersion()).toBe(current);
	}, 30_000);
	test("delivers one version to both personal CLIs and refuses edited settings", async () => {
		const home = await mkdtemp(join(root, "personal-"));
		const current = await activeToolkitVersion();
		await enrollPersonalToolkit(home, current);
		const configPath = join(home, ".codex/config.toml");
		const config = await readFile(configPath, "utf8");
		expect(config).toContain(current);
		expect(config).toContain("PWTEST_SOCKETS_DIR");
		const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
		expect(claude.mcpServers.factory_graphify.args.join(" ")).toContain(current);
		await applyToolkitVersion(current);
		expect(await readFile(configPath, "utf8")).toBe(config);
		await writeFile(
			configPath,
			config.replace("startup_timeout_sec = 60", "startup_timeout_sec = 90"),
		);
		await expect(applyToolkitVersion(current)).rejects.toThrow("was edited");
		expect(await activeToolkitVersion()).toBe(current);
	}, 30_000);
	test("keeps CLI fallback pinned across new versions, personal rollback and both run formats", async () => {
		const old = await publishToolkitVersion({
			...TOOLKIT,
			playwright: { ...TOOLKIT.playwright, cliVersion: "0.1.21" },
		});
		const latest = await publishToolkitVersion({
			...TOOLKIT,
			playwright: { ...TOOLKIT.playwright, cliVersion: "0.1.23" },
		});
		const home = await mkdtemp(join(root, "pinned-personal-"));
		await enrollPersonalToolkit(home, latest.version);
		const reference = (base: string, format: string) =>
			readFile(join(base, format, "skills/browser-checks/PINNED-CLI.md"), "utf8");
		expect(await reference(home, ".agents")).toContain("@playwright/cli@0.1.23");
		await applyToolkitVersion(old.version);
		for (const format of [".agents", ".claude"])
			expect(await reference(home, format)).toContain("@playwright/cli@0.1.21");
		await applyToolkitVersion(latest.version);
		const run = await mkdtemp(join(root, "pinned-run-"));
		const pack = await toolkitSkillPack(old.version);
		const version = resolveToolkitBundle(old.version).catalog.playwright.cliVersion;
		await materializeCodexSkillPack(run, pack, version);
		await materializeSkillPack(run, pack, version);
		for (const format of [".agents", ".claude"])
			expect(await reference(run, format)).toContain("@playwright/cli@0.1.21");
		expect(await activeToolkitVersion()).toBe(latest.version);
	}, 30_000);
	test("does not let first initialization overwrite an explicitly selected version", async () => {
		const selected = await publishToolkitVersion({
			...TOOLKIT,
			playwright: { ...TOOLKIT.playwright, cliVersion: "0.1.21" },
		});
		await rm(join(root, "toolkits", "active.json"));
		const release = acquireFileLock(toolkitUpdateLock());
		const initializing = activeToolkitVersion();
		try {
			await Bun.sleep(30);
			await activateToolkitVersion(selected.version);
		} finally {
			release();
		}
		expect(await initializing).toBe(selected.version);
		expect(await activeToolkitVersion()).toBe(selected.version);
	}, 30_000);
});
