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

/** Write the files every connected project carries. Existing config is kept. */
export function writeConnectFiles(dir: string, gate: string, defaultBranch: string): void {
	const config = join(dir, ".warren", "config.yaml");
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

function connectExisting(dir: string, gate: string): void {
	if (run(["git", "status", "--porcelain"], dir) !== "") {
		throw new Error(`${dir} has uncommitted changes; commit or stash them first`);
	}
	const defaultBranch = defaultBranchOf(dir);
	run(["git", "fetch", "origin", defaultBranch], dir);
	run(["git", "checkout", "-B", BRANCH, `origin/${defaultBranch}`], dir);
	initTrackers(dir);
	writeConnectFiles(dir, gate, defaultBranch);
	console.log(`Prepared ${dir} on branch ${BRANCH}.`);
}

function finish(dir: string): void {
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
		["bun", "src/cli/main.ts", "add-project", httpsUrl.replace(/\.git$/, "")],
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

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

function main(argv: readonly string[]): void {
	const [command, target, ...rest] = argv;
	if (target === undefined) throw new Error("usage: see the header of scripts/connect-project.ts");
	if (command === "new") {
		const parent = flagValue(rest, "--dir") ?? join(homedir(), "Prog");
		createNew(target, resolve(parent), !rest.includes("--no-register"));
		return;
	}
	const dir = resolve(target);
	if (command === "existing") {
		const gate = flagValue(rest, "--gate");
		if (gate === undefined) throw new Error("existing needs --gate");
		connectExisting(dir, gate);
	} else if (command === "finish") {
		finish(dir);
	} else if (command === "register") {
		register(dir);
	} else {
		throw new Error(`unknown command: ${command}`);
	}
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
