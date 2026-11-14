import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { spawnGuardedProcess } from "../sandbox/guarded-process.ts";
import { TOOLKIT } from "./catalog.ts";
import { withGraphLock } from "./graph-cache.ts";

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".swift",
	".c",
	".h",
	".cpp",
	".hpp",
	".rb",
	".php",
	".cs",
	".scala",
	".lua",
	".sh",
]);
export interface GraphVersion {
	readonly revision: string;
	readonly fingerprint: string;
	readonly packageVersion: string;
}
export interface GraphReply extends GraphVersion {
	readonly refreshed: boolean;
	readonly output: string;
	readonly evidence: "Confirm findings against the referenced source files";
}

/** Deliberately omit every model credential and disable both model and CLI fallback. */
export function graphifyEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return {
		PATH: env.PATH ?? "/usr/bin:/bin",
		HOME: env.HOME ?? homedir(),
		TMPDIR: env.TMPDIR ?? "/tmp",
		GRAPHIFY_BACKEND: "none",
		GRAPHIFY_NO_AUTO_REFRESH: "1",
		GRAPHIFY_AUTO_LABEL: "0",
	};
}

export async function runGraphCommand(
	argv: string[],
	cwd: string,
	timeoutMs = 120_000,
): Promise<string> {
	const child = await spawnGuardedProcess({
		argv,
		cwd,
		env: graphifyEnvironment(),
		stdin: "ignore",
	});
	const timer = setTimeout(() => child.cancel(), timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.proc.stdout).text(),
			new Response(child.proc.stderr).text(),
			child.proc.exited,
		]);
		if (code !== 0) throw new Error(`Local graph command failed (${code}): ${stderr.slice(-1500)}`);
		return stdout;
	} finally {
		clearTimeout(timer);
		child.cancel();
	}
}

export async function graphVersion(workspace: string): Promise<GraphVersion> {
	const revision = (await runGraphCommand(["git", "rev-parse", "HEAD"], workspace)).trim();
	const files = (
		await runGraphCommand(
			["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			workspace,
		)
	)
		.split("\0")
		.filter(Boolean);
	const hash = createHash("sha256").update(revision);
	for (const file of [...new Set(files)].sort()) {
		if (!CODE_EXTENSIONS.has(extname(file))) continue;
		const path = resolve(workspace, file);
		if (!path.startsWith(`${workspace}${sep}`)) throw new Error("Graph source escapes workspace");
		let stat: Awaited<ReturnType<typeof lstat>>;
		try {
			stat = await lstat(path);
		} catch {
			hash.update(`${file}:deleted`);
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink()) continue;
		hash.update(file).update(await readFile(path));
	}
	return { revision, fingerprint: hash.digest("hex"), packageVersion: TOOLKIT.graphify.version };
}

export async function queryGraph(workspacePath: string, query?: string): Promise<GraphReply> {
	const workspace = await realpath(workspacePath);
	const root = join(
		homedir(),
		".cache",
		"factory",
		"graphify",
		createHash("sha256").update(workspace).digest("hex"),
	);
	await mkdir(root, { recursive: true });
	return withGraphLock(root, () => queryCurrentGraph(workspace, root, query));
}

async function queryCurrentGraph(
	workspace: string,
	root: string,
	query?: string,
): Promise<GraphReply> {
	const version = await graphVersion(workspace);
	let previous: unknown;
	try {
		previous = JSON.parse(await readFile(join(root, "version.json"), "utf8"));
	} catch {
		previous = undefined;
	}
	const refreshed =
		JSON.stringify(previous) !== JSON.stringify(version) ||
		!existsSync(join(root, "graphify-out", "graph.json"));
	const command = [
		"uvx",
		"--from",
		`${TOOLKIT.graphify.package}==${TOOLKIT.graphify.version}`,
		"graphify",
	];
	if (refreshed) {
		await runGraphCommand(
			[...command, "extract", workspace, "--code-only", "--no-cluster", "--out", root],
			workspace,
		);
		const after = await graphVersion(workspace);
		if (after.fingerprint !== version.fingerprint)
			throw new Error("Code changed while indexing; retry on the current workspace");
		await writeFile(join(root, "version.json"), `${JSON.stringify(version)}\n`, { mode: 0o600 });
	}
	const output = query
		? await runGraphCommand(
				[
					...command,
					"query",
					query,
					"--graph",
					join(root, "graphify-out", "graph.json"),
					"--budget",
					"2000",
				],
				workspace,
			)
		: "Current code graph indexed locally";
	if ((await graphVersion(workspace)).fingerprint !== version.fingerprint)
		throw new Error("Code changed during graph query; results are stale");
	return {
		...version,
		refreshed,
		output,
		evidence: "Confirm findings against the referenced source files",
	};
}
