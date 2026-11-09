import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
	test("writes the factory files and keeps an existing Warren config", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".warren"));
		writeFileSync(join(dir, ".warren/config.yaml"), "mine: true\n");

		writeConnectFiles(dir, "make check", "main");

		expect(readFileSync(join(dir, ".warren/config.yaml"), "utf8")).toBe("mine: true\n");
		expect(existsSync(join(dir, "docs/agents/issue-tracker.md"))).toBe(true);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("## Agent skills");
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
