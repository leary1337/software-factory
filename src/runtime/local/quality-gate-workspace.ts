/** A fresh gate checkout borrows only the host's immutable object store. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { SandboxProfile } from "../../sandbox/types.ts";
import { HOST_GIT_CONFIG_ARGS } from "../../workspace/git/host-git.ts";

export interface QualityGateWorkspace {
	readonly profile: SandboxProfile;
	verify(): Promise<void>;
	cleanup(): Promise<void>;
}

interface Fingerprint {
	readonly path: string;
	readonly mode: string;
	readonly hash: string;
}

function cleanGitEnv(home: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_DEFAULT_REF_FORMAT: "files",
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function git(root: string, home: string, args: string[]): Promise<string> {
	// This directory is newly created and never exposed to an agent. All calls
	// select the new metadata explicitly; no mutable run repository is discovered.
	const proc = Bun.spawn(["git", ...HOST_GIT_CONFIG_ARGS, ...args], {
		cwd: root,
		env: cleanGitEnv(home),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
		killSignal: "SIGKILL",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`Cannot prepare independent gate: ${stderr.slice(0, 300)}`);
	return stdout;
}

async function fingerprint(workspace: string, path: string, mode: string): Promise<string> {
	if (isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "." || !part))
		throw new Error(`Invalid gate source path: ${path}`);
	const file = join(workspace, path);
	if ((await realpath(dirname(file))) !== dirname(file))
		throw new Error(`Gate source parent changed: ${path}`);
	const info = await lstat(file);
	const hash = createHash("sha256");
	if (mode === "120000" && info.isSymbolicLink()) {
		hash.update(await readlink(file, { encoding: "buffer" }));
	} else if ((mode === "100644" || mode === "100755") && info.isFile()) {
		if (((info.mode & 0o111) !== 0) !== (mode === "100755"))
			throw new Error(`Gate source mode changed: ${path}`);
		for await (const chunk of createReadStream(file)) hash.update(chunk);
	} else {
		throw new Error(`Independent gate cannot verify file mode ${mode}: ${path}`);
	}
	return hash.digest("hex");
}

async function captureFiles(
	root: string,
	home: string,
	workspace: string,
	metadata: string,
	commit: string,
): Promise<Fingerprint[]> {
	const tree = await git(root, home, [
		`--git-dir=${metadata}`,
		"ls-tree",
		"-r",
		"-z",
		"--full-tree",
		commit,
	]);
	const files: Fingerprint[] = [];
	for (const record of tree.split("\0").filter(Boolean)) {
		const match = /^(\d{6}) (?:blob|commit) [a-f0-9]{40}\t([\s\S]+)$/.exec(record);
		if (!match?.[1] || !match[2])
			throw new Error("Independent gate received invalid Git tree data");
		const [mode, path] = [match[1], match[2]];
		files.push({ path, mode, hash: await fingerprint(workspace, path, mode) });
	}
	return files;
}

function gateProfile(
	original: SandboxProfile,
	root: string,
	metadata: string,
	proxyEnv: Record<string, string> | undefined,
	shortTemp: string | undefined,
): SandboxProfile {
	if (!original.workspaceGit) throw new Error("Independent gate requires trusted host Git objects");
	const home = join(root, "home");
	const env: Record<string, string> = {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
		BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
		npm_config_cache: join(home, "npm-cache"),
		XDG_CACHE_HOME: join(home, "cache"),
		TMPDIR: shortTemp ?? join(home, "tmp"),
		PWTEST_SOCKETS_DIR: shortTemp ?? join(home, "tmp"),
	};
	for (const name of [
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"all_proxy",
		"no_proxy",
	]) {
		if (proxyEnv?.[name]) env[name] = proxyEnv[name];
	}
	const { gitconfigFile: _identity, sshAuthSock: _ssh, ...base } = original;
	if (original.projectInputsPath) env.WARREN_PROJECT_INPUTS = original.projectInputsPath;
	return {
		...base,
		workspace: join(root, "workspace"),
		home: join(root, "home"),
		readOnlyMounts: original.projectInputsPath ? [original.projectInputsPath] : [],
		envPassthrough: [],
		setEnv: env,
		workspaceGit: {
			...original.workspaceGit,
			// Seatbelt allows shared temporary roots; explicitly exclude the former
			// agent trees so an absolute path cannot recover its auth or poisoned cache.
			deniedRoots: [
				...original.workspaceGit.deniedRoots,
				original.home,
				original.workspace,
				...original.readOnlyMounts.filter((path) => path !== original.projectInputsPath),
			],
			// Mount root cannot be renamed, including under macOS's shared /tmp grant.
			// Only metadata is readonly; checkout, caches and HOME remain disposable.
			gitDir: root,
			protectedPaths: [metadata],
		},
	};
}

export async function prepareQualityGateWorkspace(
	original: SandboxProfile,
	commit: string,
	proxyEnv?: Record<string, string>,
): Promise<QualityGateWorkspace> {
	const shared = original.workspaceGit?.sharedObjects;
	if (!shared || !/^[a-f0-9]{40}$/.test(commit))
		throw new Error("Independent gate requires trusted host Git objects and a pinned commit");
	const parent = await realpath(dirname(original.home));
	const root = await mkdtemp(join(parent, ".quality-gate-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const metadata = join(root, "metadata");
	let tempAlias: string | undefined;
	const cleanup = async () => {
		if (tempAlias) await rm(tempAlias, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	};
	try {
		await mkdir(join(home, "tmp"), { recursive: true });
		if (process.platform === "darwin") {
			// sockaddr_un is limited to 104 bytes on macOS. Keep socket data in
			// private HOME, but pass a short alias to clients. Seatbelt resolves
			// the symlink to HOME's existing IPC grant; no shared socket grant.
			tempAlias = await mkdtemp("/private/tmp/wg-");
			await symlink(join(home, "tmp"), join(tempAlias, "s"));
		}
		await mkdir(workspace);
		await git(root, home, [
			"init",
			"--bare",
			"--quiet",
			"--template=",
			"--object-format=sha1",
			metadata,
		]);
		await writeFile(join(metadata, "objects/info/alternates"), `${shared}\n`);
		await git(root, home, [`--git-dir=${metadata}`, "config", "core.bare", "false"]);
		await git(root, home, [`--git-dir=${metadata}`, "config", "core.worktree", workspace]);
		await git(root, home, [
			`--git-dir=${metadata}`,
			`--work-tree=${workspace}`,
			"reset",
			"--hard",
			commit,
		]);
		await writeFile(join(workspace, ".git"), `gitdir: ${metadata}\n`);
		const files = await captureFiles(root, home, workspace, metadata, commit);
		return {
			profile: gateProfile(
				original,
				root,
				metadata,
				proxyEnv,
				tempAlias ? join(tempAlias, "s") : undefined,
			),
			async verify() {
				for (const file of files) {
					if ((await fingerprint(workspace, file.path, file.mode)) !== file.hash)
						throw new Error(`Independent gate changed reviewed source: ${file.path}`);
				}
			},
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
