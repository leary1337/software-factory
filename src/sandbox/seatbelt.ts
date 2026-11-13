/**
 * macOS: render a sandbox-exec (Seatbelt) profile and argv from a
 * SandboxProfile + SpawnCommand. Lifted from burrow's
 * `src/provider/local/seatbelt.ts` (warren-5af7).
 *
 * The .sb language is SBPL, a Scheme dialect. We start from `(deny default)`
 * and grant only what's needed: stable system reads (/usr, /System, /Library,
 * /bin, /sbin, /private/etc), a real writable HOME separate from the
 * workspace (warren-c865), the workspace (read+write), declared toolchain
 * paths (literal allow), and an optional SSH agent socket.
 *
 * Network policy:
 *   - "open"       — `(allow network*)`.
 *   - "none"       — no IP rule (default deny).
 *   - "restricted" — loopback only: bind, accept, and connect on
 *     `localhost:*`. Off-host traffic goes through `profile.proxyAddress`,
 *     a per-run userspace proxy that runs host-side and enforces the
 *     `allowedDomains` allowlist. DNS happens host-side in the proxy, so
 *     the sandbox never needs mDNSResponder access. The run dispatcher sets
 *     `proxyAddress` per-run before rendering — when it's missing,
 *     restricted mode falls back to deny-everything.
 *
 * Every policy allows unix sockets inside the workspace and the run HOME,
 * the two per-run writable trees, so tool IPC (tsx, Turbopack) works.
 * Chrome may also bind its singleton socket in the macOS temp directory;
 * connections to host sockets there remain denied.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxProfile, SpawnCommand } from "./types.ts";

export const SYSTEM_READ_SUBPATHS: readonly string[] = [
	"/usr",
	"/opt/homebrew",
	"/System",
	"/Library",
	"/bin",
	"/sbin",
	"/private/etc",
	"/private/var/db",
	"/private/var/select",
	"/dev",
];

export interface BuildSeatbeltArgvOptions {
	/** Override the sandbox-exec binary (testing or non-PATH installs). */
	sandboxExecBin?: string;
}

export interface BuildSeatbeltProfileOptions {
	/**
	 * Active Xcode developer dir (`xcode-select -p`). `undefined` resolves it
	 * on the host (cached per process); `null` means the lookup failed. Tests
	 * inject it so they never shell out.
	 */
	developerDir?: string | null;
}

export function buildSeatbeltProfile(
	profile: SandboxProfile,
	options: BuildSeatbeltProfileOptions = {},
): string {
	const lines: string[] = [];
	lines.push(";; warren sandbox profile — lifted from burrow (warren-5af7)");
	lines.push("(version 1)");
	lines.push("(deny default)");

	lines.push("(allow process-fork)");
	lines.push("(allow process-exec)");
	// The agent and test runners can stop children in their own sandbox,
	// while host processes remain outside the signal boundary.
	lines.push("(allow signal (target same-sandbox))");
	lines.push("(allow sysctl-read)");
	lines.push("(allow mach-lookup)");
	lines.push("(allow ipc-posix-shm)");
	// Python multiprocessing uses named semaphores for locks and worker queues.
	// Worker processes must reopen their parent's semaphores.
	lines.push("(allow ipc-posix-sem (semaphore-owner same-sandbox))");
	lines.push("(allow iokit-open)");
	// stat / getcwd traversal must succeed across the host fs even when data
	// reads are denied — otherwise tools like /bin/sh fail to even resolve cwd.
	lines.push("(allow file-read-metadata)");
	// dyld stats `/` early in process bringup; without this, every spawn aborts.
	lines.push('(allow file-read* (literal "/"))');
	lines.push(...ancestorReadRules(profile));

	for (const path of SYSTEM_READ_SUBPATHS) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	// Playwright's Chrome channel loads its framework and helpers from the
	// app bundle. Grant binaries only, not /Applications or the user's profile.
	lines.push('(allow file-read* (subpath "/Applications/Google Chrome.app/Contents"))');
	lines.push('(allow file-read* (literal "/Applications/Google Chrome.app"))');
	lines.push(
		'(allow mach-register (global-name-regex #"^(com[.]google[.]Chrome)?[.]MachPortRendezvousServer[.][0-9]+$"))',
	);

	for (const path of profile.toolchainPaths) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	for (const path of profile.readOnlyMounts) {
		lines.push(`(allow file-read* (subpath ${sbString(path)}))`);
	}

	// Host bun install root (warren-bea7). bun's `bun run` path and the
	// bun-shebang stubs under ~/.bun/bin resolve the real user's ~/.bun via
	// getpwuid, not $HOME — which the sandbox rewrites to profile.home. Without
	// a read grant here every `bun run <script>` fails with
	// CouldntReadCurrentDirectory and sd/ml (global bun installs) are unusable.
	// Keep the grant scoped to the install root, never the whole host home.
	// Canonicalize so seatbelt's path match doesn't miss a symlinked install.
	lines.push(`(allow file-read* (subpath ${sbString(realpathOrSelf(resolveHostBunInstall()))}))`);

	// Xcode developer bundle (warren-11e6, gh #1303). /usr/bin/git is an xcrun
	// shim that dlopens libxcrun from the active developer dir, then runs the
	// real git, which reads its gitconfig under Developer/ and frameworks under
	// SharedFrameworks/. With full Xcode that dir lives in /Applications, which
	// the system grants above do not cover, so git dies in-sandbox. Grant read
	// on the bundle's Contents only, never /Applications.
	const developerDir =
		options.developerDir === undefined ? resolveHostDeveloperDir() : options.developerDir;
	const xcodeContents = xcodeBundleContents(developerDir);
	if (xcodeContents !== null) {
		lines.push(`(allow file-read* (subpath ${sbString(xcodeContents)}))`);
	}

	lines.push(
		`(allow file-read-data file-read-metadata file-write* (subpath ${sbString(profile.workspace)}))`,
	);

	// Real writable HOME, separate from the workspace (warren-c865). Harness
	// state (.claude/, .pi/sessions/) lives here so it never lands in the git
	// worktree. $HOME is pointed at this path by resolveSandboxEnv.
	lines.push(
		`(allow file-read-data file-read-metadata file-write* (subpath ${sbString(profile.home)}))`,
	);

	// /private/tmp and /private/var/folders need read+write, not write-only.
	// claude-code's Bash tool writes command output under /tmp/claude-${uid}/...
	// (which resolves to /private/tmp via the /tmp symlink) and reads it back;
	// without file-read* the read-back fails with EPERM and claude misreports
	// it as a startup-cleanup race. /private/var/folders is the macOS per-user
	// temp dir — same asymmetry would bite anything that round-trips through
	// $TMPDIR (burrow-8452).
	lines.push('(allow file-read* file-write* (subpath "/private/tmp"))');
	lines.push('(allow file-read* file-write* (subpath "/private/var/folders"))');
	// /dev is read-allowed via SYSTEM_READ_SUBPATHS but writes are denied,
	// which breaks every shell redirect (zsh/bash `2>/dev/null`). Allow writes
	// to the universal sinks; do NOT broaden to /dev (would expose disk
	// devices and kernel entry points).
	lines.push('(allow file-write* (literal "/dev/null"))');
	lines.push('(allow file-write* (literal "/dev/dtracehelper"))');

	if (profile.sshAuthSock) {
		lines.push(`(allow file-read* file-write-data (literal ${sbString(profile.sshAuthSock)}))`);
	}

	// Emitted after every broad grant: SBPL applies the LAST matching rule, so
	// the git denies below hold even when the clone sits under /private/tmp.
	lines.push(...renderWorkspaceGitRules(profile));
	if (profile.projectInputsPath)
		lines.push(`(deny file-write* (subpath ${sbString(profile.projectInputsPath)}))`);
	const sources = profile.verificationSources;
	if (sources) {
		lines.push(`(deny file-write-unlink (literal ${sbString(profile.workspace)}))`);
		lines.push(`(deny file-write-unlink (literal ${sbString(sources.directory)}))`);
		for (const file of sources.files)
			lines.push(`(deny file-write* (literal ${sbString(join(sources.directory, file))}))`);
	}

	lines.push(...renderUnixSocketRules(profile));
	lines.push(...renderNetworkRules(profile));

	return `${lines.join("\n")}\n`;
}

/** Bun opens parent directories while finding package scripts. Grant the
 * directory itself, never its children: a subpath grant would expose secrets. */
function ancestorReadRules(profile: SandboxProfile): string[] {
	const ancestors = new Set<string>();
	for (const root of [profile.workspace, profile.home]) {
		let parent = dirname(realpathOrSelf(root));
		while (parent !== dirname(parent)) {
			ancestors.add(parent);
			parent = dirname(parent);
		}
	}
	return [...ancestors].map((path) => `(allow file-read* (literal ${sbString(path)}))`);
}

/**
 * The workspace's `.git` file points at the run's private git dir, outside
 * the workspace subpath (burrow-7a80). The run owns that dir (warren-3c1e):
 * read+write, except its `config` and `objects/info/alternates`, and its
 * root cannot be renamed or removed (bwrap/docker get that for free because
 * the root is a mount point). The host clone's git dir and the gitdirs root
 * holding sibling runs' private dirs are denied outright — even under a broad
 * grant such as /private/tmp — except the host `objects/` (readable, the
 * alternate object store) and the run's own dir. Seatbelt
 * resolves symlinks and refuses hard links and renames onto a denied path.
 */
function renderWorkspaceGitRules(profile: SandboxProfile): string[] {
	const git = profile.workspaceGit;
	if (git === undefined) return [];
	const rw = "file-read-data file-read-metadata file-write*";
	const out = [
		`(deny file-read-data file-write* (subpath ${sbString(git.hostGitDir)}))`,
		...git.deniedRoots.map(
			(root) => `(deny file-read-data file-write* (subpath ${sbString(root)}))`,
		),
		`(allow file-read-data file-read-metadata (subpath ${sbString(git.sharedObjects)}))`,
		`(allow ${rw} (subpath ${sbString(git.gitDir)}))`,
		`(deny file-write-unlink (literal ${sbString(git.gitDir)}))`,
	];
	for (const path of git.protectedPaths) {
		out.push(`(deny file-write* (subpath ${sbString(path)}))`);
	}
	return out;
}

export function buildSeatbeltArgv(
	profilePath: string,
	command: SpawnCommand,
	options: BuildSeatbeltArgvOptions = {},
): string[] {
	const bin = options.sandboxExecBin ?? "sandbox-exec";
	return [bin, "-f", profilePath, ...command.argv];
}

/**
 * Unix-domain sockets under the run's own writable trees. Build tools open
 * IPC sockets under $TMPDIR, which defaults to the private HOME on macOS:
 * tsx listens on `<TMPDIR>/tsx-<uid>/<pid>.pipe`, and without
 * this grant it fails with `listen EPERM`. Never grant connections to
 * shared temp directories: host daemons keep privileged sockets there.
 * Chrome needs only a narrowly named bind exception in its macOS temp dir.
 */
function renderUnixSocketRules(profile: SandboxProfile): string[] {
	if (profile.network === "open") return [];
	// Chrome obtains the macOS temp dir via confstr, ignoring TMPDIR. It
	// binds its profile singleton there. Binding is safe; connecting to
	// host sockets remains denied, including an existing Chrome instance.
	const temp = realpathOrSelf(tmpdir()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const singleton = `^${temp}/[^/]+/SingletonSocket$`;
	return [
		`(allow network-bind (local unix-socket (regex ${sbString(singleton)})))`,
		...[profile.workspace, profile.home].flatMap((root) => [
			`(allow network-bind (local unix-socket (subpath ${sbString(root)})))`,
			`(allow network-outbound (remote unix-socket (subpath ${sbString(root)})))`,
		]),
	];
}

function renderNetworkRules(profile: SandboxProfile): string[] {
	if (profile.network === "open") return ["(allow network*)"];
	if (profile.network === "none") return [];

	// network=restricted. The host-side userspace proxy enforces the
	// allowlist for off-host traffic. Without a proxyAddress we leave the
	// rules empty — the legacy hostname regex was a no-op (sandbox-exec
	// matches against the resolved IP, not the hostname) and silently
	// denied everything; explicit deny is at least honest.
	if (!profile.proxyAddress) return [];

	// Loopback is open in full, not just the proxy port. Quality gates bind
	// local ports: Turbopack's `next build` workers listen on loopback, and a
	// smoke test serves the app and curls it. With only the proxy port
	// allowed, `next build` hung until the Bash timeout and then failed with
	// `binding to a port - Operation not permitted`. sandbox-exec cannot tell
	// the sandbox's own listeners from the host's, so the agent can also
	// reach host loopback services. That matches bwrap, whose restricted
	// mode shares the host net namespace (src/sandbox/bwrap.ts).
	//
	// The `ip` host token only accepts `localhost` or `*` in sandbox-exec's
	// grammar (numeric IPs raise `host must be * or localhost in network
	// address`). `localhost` covers both `127.0.0.1` and `::1`.
	const loopback = sbString("localhost:*");
	return [
		`(allow network-bind (local ip ${loopback}))`,
		`(allow network-inbound (local ip ${loopback}))`,
		`(allow network-outbound (remote ip ${loopback}))`,
	];
}

/**
 * Host path of the invoking user's bun install root. Prefers `$BUN_INSTALL`,
 * otherwise `~/.bun`. Exported so tests can pin the same path the profile
 * renders without re-deriving the precedence.
 */
export function resolveHostBunInstall(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const fromEnv = env.BUN_INSTALL;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return join(home, ".bun");
}

let cachedDeveloperDir: string | null | undefined;

/**
 * Host's active developer dir via `xcode-select -p`, or null off darwin or
 * when the lookup fails. Resolved once per process.
 */
export function resolveHostDeveloperDir(): string | null {
	if (cachedDeveloperDir !== undefined) return cachedDeveloperDir;
	cachedDeveloperDir = null;
	if (process.platform !== "darwin") return cachedDeveloperDir;
	try {
		const res = spawnSync("xcode-select", ["-p"], { encoding: "utf8", timeout: 5_000 });
		const out = res.status === 0 ? res.stdout.trim() : "";
		if (out.length > 0) cachedDeveloperDir = out;
	} catch {
		// xcode-select missing: no grant
	}
	return cachedDeveloperDir;
}

/**
 * The `<bundle>.app/Contents` dir to grant for an Xcode developer dir, or
 * null when there is nothing extra to grant: no dir, a Command Line Tools
 * dir (already under /Library), or a dir outside an app bundle.
 */
export function xcodeBundleContents(developerDir: string | null): string | null {
	if (developerDir === null || developerDir.length === 0) return null;
	const match = /^(\/.+\.app\/Contents)\/Developer\/?$/.exec(realpathOrSelf(developerDir));
	const contents = match?.[1];
	if (contents === undefined) return null;
	const covered = SYSTEM_READ_SUBPATHS.some((p) => contents.startsWith(`${p}/`));
	return covered ? null : contents;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Quote a string for SBPL: escape backslash and double-quote. */
function sbString(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}
