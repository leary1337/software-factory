import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	fixtureGitCmd,
	makePrivateGitFixture,
	type PrivateGitFixture,
} from "./git-scope.test-helpers.ts";
import {
	assertPrivateGitDirIntact,
	type PrivateGitScope,
	resolvePrivateGitScope,
	WorkspaceGitScopeError,
} from "./git-scope.ts";

function scopeOf(fx: PrivateGitFixture, checkPointer = true): PrivateGitScope {
	return resolvePrivateGitScope({
		workspacePath: fx.ws,
		gitDir: fx.gitDir,
		hostGitDir: fx.hostGitDir,
		configSha256: fx.source.gitConfigSha256 ?? "",
		checkPointer,
	});
}

describe("materializePrivateGitDir (warren-3c1e)", () => {
	let fx: PrivateGitFixture;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("checks the base out against a private git dir borrowing the host objects", () => {
		expect(readFileSync(join(fx.ws, ".git"), "utf8").trim()).toBe(`gitdir: ${fx.gitDir}`);
		expect(readFileSync(join(fx.gitDir, "objects", "info", "alternates"), "utf8")).toBe(
			`${join(fx.hostGitDir, "objects")}\n`,
		);
		expect(readFileSync(join(fx.ws, "README"), "utf8")).toBe("hi\n");
		expect(fixtureGitCmd(fx.ws, "symbolic-ref", "HEAD")).toBe("refs/heads/warren/run");
		// The base snapshot is visible in the run; the run branch is not in the host.
		expect(fixtureGitCmd(fx.ws, "rev-parse", "main")).toBe(
			fixtureGitCmd(fx.clone, "rev-parse", "main"),
		);
		expect(fixtureGitCmd(fx.clone, "branch", "--list", "warren/*")).toBe("");
		expect(fixtureGitCmd(fx.ws, "config", "remote.origin.url")).toBe(
			"https://example.invalid/o/r.git",
		);
		expect(existsSync(join(fx.gitDir, "hooks"))).toBe(false);
	});
});

describe("resolvePrivateGitScope + assertPrivateGitDirIntact", () => {
	let fx: PrivateGitFixture;
	beforeEach(async () => {
		fx = await makePrivateGitFixture();
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	test("exposes the private git dir and only the host object store", () => {
		const scope = scopeOf(fx);
		expect(scope.gitDir).toBe(fx.gitDir);
		expect(scope.hostGitDir).toBe(fx.hostGitDir);
		expect(scope.sharedObjects).toBe(join(fx.hostGitDir, "objects"));
		expect(scope.protectedPaths).toEqual([
			join(fx.gitDir, "config"),
			join(fx.gitDir, "objects", "info", "alternates"),
		]);
	});

	test("rejects a workspace .git pointing at a sibling's git dir", () => {
		writeFileSync(join(fx.ws, ".git"), `gitdir: ${fx.siblingGitDir}\n`);
		expect(() => scopeOf(fx)).toThrow(/does not point at/);
		// A re-pin after the run never consults .git.
		expect(() => scopeOf(fx, false)).not.toThrow();
	});

	test("rejects a symlink planted anywhere in the git dir", () => {
		const scope = scopeOf(fx);
		const secret = join(fx.root, "secret");
		writeFileSync(secret, "s\n");
		mkdirSync(join(fx.gitDir, "logs", "refs", "remotes"), { recursive: true });
		symlinkSync(secret, join(fx.gitDir, "logs", "refs", "remotes", "planted"));
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/is a symlink/);
	});

	test("rejects a symlinked object directory", () => {
		const scope = scopeOf(fx);
		symlinkSync(join(fx.siblingGitDir, "objects"), join(fx.gitDir, "objects", "ab"));
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(WorkspaceGitScopeError);
	});

	test("rejects a hard-linked file", () => {
		const scope = scopeOf(fx);
		const outside = join(fx.root, "outside");
		writeFileSync(outside, "x\n");
		linkSync(outside, join(fx.gitDir, "logs-hardlink"));
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/hard-linked/);
	});

	test("rejects a rewritten config, alternates, or a new commondir", () => {
		const scope = scopeOf(fx);
		const config = join(fx.gitDir, "config");
		const original = readFileSync(config);
		writeFileSync(config, `${original}[core]\n\tsshCommand = touch /tmp/x\n`);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/config changed/);
		writeFileSync(config, original);

		const alternates = join(fx.gitDir, "objects", "info", "alternates");
		writeFileSync(alternates, `${join(fx.siblingGitDir, "objects")}\n`);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/alternates changed/);
		writeFileSync(alternates, `${scope.sharedObjects}\n`);

		writeFileSync(join(fx.gitDir, "commondir"), `${fx.hostGitDir}\n`);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/commondir/);
		rmSync(join(fx.gitDir, "commondir"));
		expect(() => assertPrivateGitDirIntact(scope)).not.toThrow();
	});

	test("rejects a git dir root swapped for a symlink", () => {
		const scope = scopeOf(fx);
		renameSync(fx.gitDir, `${fx.gitDir}.real`);
		symlinkSync(`${fx.gitDir}.real`, fx.gitDir);
		expect(() => assertPrivateGitDirIntact(scope)).toThrow(/real directory/);
	});

	test("rejects a host object store reached through a symlink", () => {
		const objects = join(fx.hostGitDir, "objects");
		renameSync(objects, `${objects}.real`);
		symlinkSync(`${objects}.real`, objects);
		expect(() => scopeOf(fx)).toThrow(/not a symlink/);
	});
});
