/** Ticket 37: exercise the actual npm artifact with fresh dependencies, HOME and state. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { missingToolkitFiles } from "../check-package-toolkit.ts";

interface PackedFile {
	path: string;
}
interface PackResult {
	filename: string;
	integrity: string;
	files: PackedFile[];
}
const source = resolve(import.meta.dir, "../..");
const root = await realpath(await mkdtemp(join(tmpdir(), "factory-clean-install-")));
const home = join(root, "home");
const data = join(root, "data");
const packageRoot = join(root, "package");
const reportPath = resolve(process.argv[2] ?? join(root, "evidence.json"));
const env = {
	PATH: process.env.PATH ?? "",
	HOME: home,
	TMPDIR: tmpdir(),
	LANG: "en_US.UTF-8",
	WARREN_DATA_DIR: data,
	WARREN_DB_PATH: join(data, "warren.db"),
	WARREN_PROJECTS_DIR: join(data, "projects"),
	WARREN_BIND_HOST: "127.0.0.1",
	WARREN_BIND_PORT: "0",
	WARREN_FORGE: "fake",
	WARREN_RUNTIME: "local",
	WARREN_LOG_LEVEL: "warn",
	GIT_CONFIG_GLOBAL: join(root, "git-config"),
};
const steps: Record<string, unknown> = {};
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
async function run(command: string[], cwd: string, name: string) {
	const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	await writeFile(join(root, `${name}.stdout.log`), stdout);
	await writeFile(join(root, `${name}.stderr.log`), stderr);
	assert(exitCode === 0, `${name} failed (${exitCode}); logs: ${root}`);
	return stdout;
}
async function hashes(files: readonly PackedFile[]) {
	const compared: Record<string, string> = {};
	for (const { path } of files) {
		const original = await readFile(join(source, path));
		const packed = await readFile(join(packageRoot, path));
		assert(digest(original) === digest(packed), `Source changed while packing: ${path}`);
		compared[path] = digest(packed);
	}
	const body = `${JSON.stringify(compared, null, 2)}\n`;
	const manifestPath = `${reportPath.replace(/\.json$/, "")}.hashes.json`;
	await mkdir(resolve(manifestPath, ".."), { recursive: true });
	await writeFile(manifestPath, body);
	return {
		count: files.length,
		manifestSha256: digest(Buffer.from(body)),
		manifest: manifestPath,
	};
}
async function waitForServer(child: Bun.Subprocess, log: string) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Packed server exited early: ${root}`);
		const output = await readFile(log, "utf8").catch(() => "");
		const url = output.match(/warren listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
		if (url) {
			const response = await fetch(`${url}/healthz`);
			if (response.ok) return url;
		}
		await Bun.sleep(50);
	}
	throw new Error(`Packed server startup timed out: ${root}`);
}
async function getJson(url: string): Promise<Record<string, unknown>> {
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	assert(response.ok, `Packaged HTTP check failed: ${new URL(url).pathname} ${response.status}`);
	return (await response.json()) as Record<string, unknown>;
}
async function verifyServer(url: string) {
	const health = await getJson(`${url}/healthz`);
	const agents = await getJson(`${url}/agents`);
	assert(Array.isArray(agents.agents), "Missing agent registry");
	const names = agents.agents.map((agent: { name: string }) => agent.name).sort();
	assert(names.length === 7, `Expected seven active definitions, got ${names.length}`);
	assert(
		!names.some((name: string) => ["pi", "nightwatch", "bugwatch"].includes(name)),
		"Retired built-in remains active",
	);
	const instance = await getJson(`${url}/instance`);
	assert(instance.runtime === "local", "Fresh install did not select local runtime");
	const toolkit = await getJson(`${url}/toolkit`);
	assert(
		typeof toolkit.activeVersion === "string" && toolkit.activeVersion.length === 64,
		"Missing toolkit version",
	);
	const html = await fetch(`${url}/`).then((response) => response.text());
	assert(html.includes('<div id="root">'), "Packaged UI root missing");
	const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
	assert(assets.length >= 2, "Packaged UI assets missing");
	for (const path of assets)
		assert((await fetch(`${url}${path}`)).ok, `Packaged asset unavailable: ${path}`);
	const runs = await getJson(`${url}/runs`);
	const plans = await getJson(`${url}/plan-runs`);
	assert(
		Array.isArray(runs.runs) && runs.runs.length === 0,
		"Fresh installation contains another queue",
	);
	assert(
		Array.isArray(plans.planRuns) && plans.planRuns.length === 0,
		"Fresh installation contains another plan queue",
	);
	return {
		url,
		health,
		agentNames: names,
		runtime: instance.runtime,
		toolkitVersion: toolkit.activeVersion,
		uiAssetCount: assets.length,
		freshQueue: true,
	};
}
async function packedSkills() {
	const program = `
import {loadSkillCatalog} from './src/runtime/local/skill-catalog.ts';
import {materializeCodexSkillPack,materializeSkillPack} from './src/runtime/local/skill-pack.ts';
import {allAdapters} from './src/runtime/adapters/index.ts';
import {scaffold} from './src/projects/template.ts';
import {existsSync} from 'node:fs';
import {toolkitServers} from './src/toolkit/catalog.ts';
import {readdir,readFile} from 'node:fs/promises';
const home=${JSON.stringify(join(root, "materialized-home"))};
const project=${JSON.stringify(join(root, "scaffolded-project"))};
scaffold(project,'clean-app','example.invalid/clean-app');
const ignore=await readFile(project+'/.gitignore','utf8');
if(!ignore.includes('node_modules/') || !ignore.includes('.env') || existsSync(project+'/gitignore.template')) throw new Error('Packaged project ignore rules missing');
const catalog=await loadSkillCatalog(); await materializeCodexSkillPack(home); await materializeSkillPack(home);
const agents=JSON.parse(await readFile(home+'/.agents/factory-skills.json','utf8'));
const claude=JSON.parse(await readFile(home+'/.claude/factory-skills.json','utf8'));
const expected=catalog.skills.filter(s=>s.audiences.includes('factory')).length;
const codexCount=(await readdir(home+'/.agents/skills')).length; const claudeCount=(await readdir(home+'/.claude/skills')).length;
if(codexCount!==expected || claudeCount!==expected || agents.version!==claude.version || agents.version!==catalog.version) throw new Error('Materialized skill catalog mismatch');
console.log(JSON.stringify({templateIgnoreRules:true,catalogSkills:catalog.skills.length,factorySkills:expected,codexCount,claudeCount,skillVersion:catalog.version,runtimes:allAdapters().map(a=>a.runtimeId),mcpServers:Object.keys(toolkitServers())}));`;
	const result = JSON.parse(
		await run(
			[process.execPath, "--env-file=/dev/null", "-e", program],
			packageRoot,
			"packed-skills",
		),
	);
	assert(
		!result.runtimes.includes("pi") && result.runtimes.includes("codex"),
		"Pi remains executable or Codex missing",
	);
	return result;
}

let server: Bun.Subprocess | undefined;
try {
	await mkdir(home, { recursive: true });
	await mkdir(data, { recursive: true });
	await writeFile(env.GIT_CONFIG_GLOBAL, "[init]\n defaultBranch = main\n");
	steps.sourceHead = (await run(["git", "rev-parse", "HEAD"], source, "source-head")).trim();
	steps.snapshotKind = "working-tree snapshot; not a release commit";
	steps.startedAt = new Date().toISOString();
	const packed = JSON.parse(
		await run(
			["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", root],
			source,
			"pack",
		),
	) as PackResult[];
	const artifact = packed[0];
	assert(artifact, "npm pack returned no artifact");
	assert(
		missingToolkitFiles(artifact.files.map((file) => file.path)).length === 0,
		"Package omits toolkit files",
	);
	await run(["tar", "-xzf", join(root, artifact.filename), "-C", root], root, "unpack");
	steps.package = {
		filename: artifact.filename,
		integrity: artifact.integrity,
		...(await hashes(artifact.files)),
	};
	await run(
		[process.execPath, "install", "--production", "--ignore-scripts"],
		packageRoot,
		"install",
	);
	assert(
		(await realpath(join(packageRoot, "node_modules/zod"))).startsWith(root),
		"Dependencies leaked from the workspace",
	);
	const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	assert(
		!Object.keys(manifest.dependencies).some((name) =>
			/docker|pi-coding|burrow|canopy|mulch|seeds/.test(name),
		),
		"Removed infrastructure remains a production dependency",
	);
	for (const path of [
		"Dockerfile",
		"src/runtime/docker",
		"src/runtime/container/agent-entrypoint.ts",
		"src/runtime/container/workspace-init.ts",
		"extensions",
		"src/sandbox/bwrap.ts",
		"src/sandbox/seatbelt.ts",
	])
		assert(!existsSync(join(packageRoot, path)), `Retired executable path remains: ${path}`);
	const prime = await run(
		[process.execPath, "--env-file=/dev/null", "src/cli/main.ts", "prime"],
		packageRoot,
		"prime",
	);
	assert(prime.includes("warren") && prime.includes("dispatch"), "Packaged CLI prime failed");
	steps.productionDependencies = Object.keys(manifest.dependencies).sort();
	steps.skills = await packedSkills();
	const stdout = join(root, "server.stdout.log");
	server = Bun.spawn(
		[process.execPath, "--env-file=/dev/null", "src/cli/main.ts", "serve", "--no-auth"],
		{
			cwd: packageRoot,
			env,
			stdout: Bun.file(stdout),
			stderr: Bun.file(join(root, "server.stderr.log")),
		},
	);
	steps.server = await verifyServer(await waitForServer(server, stdout));
	server.kill("SIGTERM");
	const code = await Promise.race([server.exited, Bun.sleep(10_000).then(() => "timeout")]);
	assert(code === 0, `Packaged server did not stop cleanly: ${code}`);
	steps.serverStopped = true;
	steps.codexAuthenticationAccessed = false;
	steps.agentExecution =
		"Not performed in ticket 37. Ticket 38 owns real preparation, Codex execution and independent gate evidence; this report does not claim those checks passed.";
	steps.status = "passed";
} catch (error) {
	steps.status = "failed";
	steps.error = error instanceof Error ? error.message : String(error);
	process.exitCode = 1;
} finally {
	if (server && server.exitCode === null) {
		server.kill("SIGKILL");
		await server.exited;
	}
	steps.finishedAt = new Date().toISOString();
	steps.artifacts = root;
	await mkdir(resolve(reportPath, ".."), { recursive: true });
	await writeFile(reportPath, `${JSON.stringify(steps, null, 2)}\n`);
	console.log(
		JSON.stringify({
			status: steps.status,
			evidence: reportPath,
			artifacts: root,
			error: steps.error,
		}),
	);
}
