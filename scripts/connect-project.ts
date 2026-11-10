#!/usr/bin/env bun
/**
 * Connects a repository to the factory. The /connect-project command drives it.
 *
 *   existing <path> --gate "<command>"   branch and write the factory files
 *   finish <path>                        commit, push and open the PR
 *   new <name> [--dir <parent>]          create a private repo from the template
 *   register <path>                      add the project to the running Warren
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { load } from "js-yaml";
import { parseDefaultsConfig } from "../src/warren-config/schema.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONNECT_DIR = join(REPO_ROOT, "factory", "connect");
const TEMPLATE_DIR = join(REPO_ROOT, "factory", "template");
const BRANCH = "factory/connect";
const TEMPLATE_GATE = "./scripts/check.sh";

const AGENT_SKILLS_BLOCK = `## Agent skills

### Issue tracker

Tickets live in Seeds (\`.seeds/\`), managed with the \`sd\` CLI. See \`docs/agents/issue-tracker.md\`.

### Domain docs

Single-context: \`GLOSSARY.md\` and \`docs/adr/\` at the repo root. See \`docs/agents/domain.md\`.
`;

export function renderWarrenConfig(gate: string, defaultBranch: string): string {
	return [
		"defaultRole: implementer",
		`defaultBranch: ${defaultBranch}`,
		"runBranchPrefix: factory",
		`qualityGate: ${JSON.stringify(gate)}`,
		"maxCostUsd: 10",
		"",
	].join("\n");
}

/** Add the block, or refresh it in place when the file already has one. */
export function upsertAgentSkillsBlock(existing: string): string {
	const start = existing.indexOf("## Agent skills");
	if (start === -1) {
		return existing === "" ? AGENT_SKILLS_BLOCK : `${existing.trimEnd()}\n\n${AGENT_SKILLS_BLOCK}`;
	}
	const next = existing.slice(start + 1).search(/^## /m);
	const tail = next === -1 ? "" : `\n${existing.slice(start + 1 + next)}`;
	return `${existing.slice(0, start)}${AGENT_SKILLS_BLOCK}${tail}`;
}

/** CLAUDE.md wins when both or only it exists; AGENTS.md is the default. */
export function chooseAgentsFile(dir: string): string {
	return existsSync(join(dir, "CLAUDE.md")) ? "CLAUDE.md" : "AGENTS.md";
}

export function fillPlaceholders(text: string, project: string, module: string): string {
	return text.replaceAll("__PROJECT__", project).replaceAll("__MODULE__", module);
}

function walkFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walkFiles(path) : [path];
	});
}

/** Copy the project template into `dir`, filling in its name and Go module. */
export function scaffold(dir: string, project: string, module: string): void {
	cpSync(TEMPLATE_DIR, dir, { recursive: true });
	for (const file of walkFiles(dir)) {
		if (file.includes("/node_modules/") || basename(file) === "bun.lock") continue;
		const text = readFileSync(file, "utf8");
		const filled = fillPlaceholders(text, project, module);
		if (filled !== text) writeFileSync(file, filled);
	}
}

/** Keep existing config byte-for-byte, but never silently ignore the requested gate. */
export function assertMatchingGate(configPath: string, gate: string): void {
	if (!gate.trim()) throw new Error("--gate must be a non-empty command");
	if (!existsSync(configPath)) {
		if (existsSync(join(dirname(configPath), "defaults.json"))) {
			throw new Error(
				"Migrate .warren/defaults.json with warren config migrate --cwd <path> before connecting; legacy settings were kept.",
			);
		}
		return;
	}
	const parsed = parseDefaultsConfig(load(readFileSync(configPath, "utf8")));
	if (!parsed.ok) throw new Error(`${configPath} is invalid; fix it before connecting`);
	if (parsed.value.qualityGate !== gate) {
		throw new Error(
			`${configPath} has a different or missing qualityGate. Update it explicitly or pass its existing command with --gate; no settings were overwritten.`,
		);
	}
}

/** Write the files every connected project carries. Existing config is kept. */
export function writeConnectFiles(dir: string, gate: string, defaultBranch: string): void {
	const config = join(dir, ".warren", "config.yaml");
	assertMatchingGate(config, gate);
	if (!existsSync(config)) {
		mkdirSync(dirname(config), { recursive: true });
		writeFileSync(config, renderWarrenConfig(gate, defaultBranch));
	}
	cpSync(join(CONNECT_DIR, "docs"), join(dir, "docs"), { recursive: true, force: false });
	const agentsFile = join(dir, chooseAgentsFile(dir));
	const current = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
	writeFileSync(agentsFile, upsertAgentSkillsBlock(current));
}

function run(command: string[], cwd: string): string {
	const [bin = "", ...args] = command;
	const result = spawnSync(bin, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
	}
	return result.stdout.trim();
}

function initTrackers(dir: string): void {
	if (!existsSync(join(dir, ".seeds"))) run(["sd", "init"], dir);
	if (!existsSync(join(dir, ".mulch"))) run(["ml", "init"], dir);
}

function defaultBranchOf(dir: string): string {
	return run(
		["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
		dir,
	);
}

export function assertConnectBranchAvailable(dir: string): void {
	if (run(["git", "branch", "--list", BRANCH], dir) !== "") {
		throw new Error(
			`${BRANCH} already exists; finish or preserve that work before connecting again. It was not reset.`,
		);
	}
}

export function assertOnConnectBranch(dir: string): void {
	if (run(["git", "branch", "--show-current"], dir) !== BRANCH) {
		throw new Error(`Switch to ${BRANCH} before finish; no files were staged or committed.`);
	}
}

function connectExisting(dir: string, gate: string): void {
	if (run(["git", "status", "--porcelain"], dir) !== "") {
		throw new Error(`${dir} has uncommitted changes; commit or stash them first`);
	}
	assertConnectBranchAvailable(dir);
	assertMatchingGate(join(dir, ".warren", "config.yaml"), gate);
	const defaultBranch = defaultBranchOf(dir);
	run(["git", "fetch", "origin", defaultBranch], dir);
	run(["git", "checkout", "-b", BRANCH, `origin/${defaultBranch}`], dir);
	writeConnectFiles(dir, gate, defaultBranch);
	initTrackers(dir);
	console.log(`Prepared ${dir} on branch ${BRANCH}.`);
}

function finish(dir: string): void {
	assertOnConnectBranch(dir);
	run(["git", "add", "-A"], dir);
	run(["git", "commit", "-m", "chore: подключить проект к фабрике"], dir);
	run(["git", "push", "-u", "origin", BRANCH], dir);
	const url = run(["gh", "pr", "create", "--fill", "--base", defaultBranchOf(dir)], dir);
	console.log(`PR: ${url}`);
	console.log(`After merging the PR, run: bun scripts/connect-project.ts register ${dir}`);
}

function register(dir: string): void {
	const url = run(["git", "remote", "get-url", "origin"], dir);
	const httpsUrl = url.replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, "https://github.com/");
	const output = run(
		[
			"bun",
			"--env-file=/dev/null",
			"src/cli/main.ts",
			"add-project",
			httpsUrl.replace(/\.git$/, ""),
		],
		REPO_ROOT,
	);
	console.log(output);
}

function createNew(name: string, parent: string, shouldRegister: boolean): void {
	const dir = join(parent, name);
	if (existsSync(dir)) throw new Error(`${dir} already exists`);
	const owner = run(["gh", "api", "user", "--jq", ".login"], REPO_ROOT);
	mkdirSync(dir, { recursive: true });
	scaffold(dir, name, `github.com/${owner}/${name}`);
	run(["git", "init", "-b", "main"], dir);
	initTrackers(dir);
	writeConnectFiles(dir, TEMPLATE_GATE, "main");
	run(["gh", "repo", "create", `${owner}/${name}`, "--private"], dir);
	run(["git", "remote", "add", "origin", `https://github.com/${owner}/${name}`], dir);
	run(["git", "add", "-A"], dir);
	run(["git", "commit", "-m", "chore: создать проект из шаблона фабрики"], dir);
	run(["git", "push", "-u", "origin", "main"], dir);
	console.log(`Created ${dir}.`);
	if (shouldRegister) console.log(`Next run: bun scripts/connect-project.ts register ${dir}`);
}

function main(argv: readonly string[]): void {
	const command = new Command("bun scripts/connect-project.ts")
		.description("Connect a project to the local factory. Requires git, gh, sd and ml.")
		.addHelpText(
			"after",
			"\nUse $connect-project in Codex for glossary, verification and planning.\nGitHub token access must include the selected project before register.",
		);
	command
		.command("existing <path>")
		.description("Prepare factory/connect from the remote default branch; keep existing settings")
		.requiredOption("--gate <command>", "quality gate; must match an existing config")
		.action((path: string, options: { gate: string }) =>
			connectExisting(resolve(path), options.gate),
		);
	command
		.command("finish <path>")
		.description("Commit prepared files, push factory/connect and open its pull request")
		.action((path: string) => finish(resolve(path)));
	command
		.command("new <name>")
		.description("Create and push a private GitHub repo from the Go/React template")
		.option("--dir <parent>", "parent directory", join(homedir(), "Prog"))
		.option(
			"--no-register",
			"suppress the next-step registration hint (registration is always explicit)",
		)
		.action((name: string, options: { dir: string; register: boolean }) => {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
				throw new Error("name must be a repository name, not a path");
			}
			createNew(name, resolve(options.dir), options.register);
		});
	command
		.command("register <path>")
		.description("Register the repository with running Warren after onboarding is merged")
		.action((path: string) => register(resolve(path)));
	command.parse(argv, { from: "user" });
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
