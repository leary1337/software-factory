import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertConnectBranchAvailable,
	assertOnConnectBranch,
	chooseAgentsFile,
	fillPlaceholders,
	renderWarrenConfig,
	scaffold,
	upsertAgentSkillsBlock,
	writeConnectFiles,
} from "./connect-project.ts";

const temps: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "connect-project-"));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("renderWarrenConfig", () => {
	test("quotes the gate so any shell command stays valid YAML", () => {
		expect(renderWarrenConfig("go test ./... # all", "main")).toContain(
			'qualityGate: "go test ./... # all"',
		);
	});
});

describe("upsertAgentSkillsBlock", () => {
	test("appends the block once and refreshes it on a second pass", () => {
		const once = upsertAgentSkillsBlock("# Project\n");
		expect(once.startsWith("# Project\n\n## Agent skills")).toBe(true);
		expect(upsertAgentSkillsBlock(once)).toBe(once);
	});

	test("keeps the sections after an existing block", () => {
		const updated = upsertAgentSkillsBlock("## Agent skills\n\nold\n\n## Deploy\n\nsteps\n");
		expect(updated).not.toContain("old");
		expect(updated).toContain("## Deploy\n\nsteps");
	});
});

describe("chooseAgentsFile", () => {
	test("prefers an existing CLAUDE.md", () => {
		const dir = tempDir();
		expect(chooseAgentsFile(dir)).toBe("AGENTS.md");
		writeFileSync(join(dir, "CLAUDE.md"), "");
		expect(chooseAgentsFile(dir)).toBe("CLAUDE.md");
	});
});

describe("writeConnectFiles", () => {
	test("writes the factory files and keeps matching config byte-for-byte", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".warren"));
		const config = '# my settings\nqualityGate: "make check"\nmaxCostUsd: 4\n';
		writeFileSync(join(dir, ".warren/config.yaml"), config);

		writeConnectFiles(dir, "make check", "main");

		expect(readFileSync(join(dir, ".warren/config.yaml"), "utf8")).toBe(config);
		expect(existsSync(join(dir, "docs/agents/issue-tracker.md"))).toBe(true);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("## Agent skills");
	});

	for (const config of ["maxCostUsd: 4\n", "qualityGate: make other\n", "qualityGate: [bad]\n"]) {
		test(`rejects an ineffective gate before writing onboarding files: ${config.trim()}`, () => {
			const dir = tempDir();
			mkdirSync(join(dir, ".warren"));
			writeFileSync(join(dir, ".warren/config.yaml"), config);
			expect(() => writeConnectFiles(dir, "make check", "main")).toThrow();
			expect(readFileSync(join(dir, ".warren/config.yaml"), "utf8")).toBe(config);
			expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
			expect(existsSync(join(dir, "docs"))).toBe(false);
		});
	}

	test("rejects an empty gate before creating config", () => {
		const dir = tempDir();
		expect(() => writeConnectFiles(dir, "  ", "main")).toThrow("non-empty");
		expect(existsSync(join(dir, ".warren"))).toBe(false);
	});

	test("keeps legacy settings instead of shadowing them with a new config", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".warren"));
		writeFileSync(join(dir, ".warren/defaults.json"), '{"qualityGate":"make check"}');
		expect(() => writeConnectFiles(dir, "make check", "main")).toThrow("config migrate");
		expect(existsSync(join(dir, ".warren/config.yaml"))).toBe(false);
		expect(readFileSync(join(dir, ".warren/defaults.json"), "utf8")).toContain("make check");
	});
});

describe("connectProjectCli", () => {
	for (const command of [[], ["existing"], ["new"], ["finish"], ["register"]]) {
		test(`shows successful help for ${command[0] ?? "all commands"}`, () => {
			const result = spawnSync(
				process.execPath,
				["--env-file=/dev/null", join(import.meta.dir, "connect-project.ts"), ...command, "--help"],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Usage:");
		});
	}

	test("rejects a missing gate without touching the target", () => {
		const dir = tempDir();
		const result = spawnSync(
			process.execPath,
			["--env-file=/dev/null", join(import.meta.dir, "connect-project.ts"), "existing", dir],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("--gate");
		expect(existsSync(join(dir, ".warren"))).toBe(false);
	});
});

describe("scaffold", () => {
	test("fills the project name and Go module everywhere", () => {
		const dir = tempDir();
		scaffold(dir, "demo", "github.com/me/demo");
		expect(readFileSync(join(dir, "go.mod"), "utf8")).toContain("module github.com/me/demo");
		expect(readFileSync(join(dir, "cmd/server/main.go"), "utf8")).toContain(
			"github.com/me/demo/internal/api",
		);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).not.toContain("__PROJECT__");
	});

	test("fillPlaceholders replaces every occurrence", () => {
		expect(fillPlaceholders("__PROJECT__ __PROJECT__ __MODULE__", "a", "b")).toBe("a a b");
	});
});

describe("onboarding branch safety", () => {
	function repo(): string {
		const dir = tempDir();
		for (const args of [
			["init", "-b", "main"],
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--allow-empty",
				"-m",
				"initial",
			],
		]) {
			const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
			expect(result.status).toBe(0);
		}
		return dir;
	}
	test("preserves an existing onboarding branch instead of resetting it", () => {
		const dir = repo();
		expect(() => assertConnectBranchAvailable(dir)).not.toThrow();
		spawnSync("git", ["branch", "factory/connect"], { cwd: dir });
		const before = spawnSync("git", ["rev-parse", "factory/connect"], {
			cwd: dir,
			encoding: "utf8",
		}).stdout;
		expect(() => assertConnectBranchAvailable(dir)).toThrow("not reset");
		expect(
			spawnSync("git", ["rev-parse", "factory/connect"], { cwd: dir, encoding: "utf8" }).stdout,
		).toBe(before);
		expect(() => assertOnConnectBranch(dir)).toThrow("no files were staged");
		spawnSync("git", ["checkout", "factory/connect"], { cwd: dir });
		expect(() => assertOnConnectBranch(dir)).not.toThrow();
	});
	test("refuses finish on the wrong branch before staging local edits", () => {
		const dir = repo();
		writeFileSync(join(dir, "keep.txt"), "unfinished work");
		const result = spawnSync(
			process.execPath,
			["--env-file=/dev/null", join(import.meta.dir, "connect-project.ts"), "finish", dir],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Switch to factory/connect");
		expect(
			spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
		).toBe("?? keep.txt");
	});
});
