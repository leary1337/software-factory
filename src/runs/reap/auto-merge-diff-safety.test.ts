import { describe, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitFixture, gitFixtureEnv } from "../../workspace/git/test-fixture.ts";
import { assessAutoMergeDiff } from "./auto-merge-diff-safety.ts";
import { computeAutoMergeChangedPaths } from "./auto-merge-git.ts";
import { decideAutoMerge } from "./auto-merge-policy.ts";
import type { ReapExec } from "./types.ts";
import { defaultExec } from "./util.ts";

const sha = "a".repeat(40);
const raw = (path: string, oldMode = "100644", newMode = "100644") =>
	`:${oldMode} ${newMode} ${sha} ${sha} M\0${path}\0`;
const exec: ReapExec = {
	run: (cmd, args, opts) => defaultExec.run(cmd, args, { ...opts, env: gitFixtureEnv(opts.cwd) }),
};

describe("assessAutoMergeDiff", () => {
	test("preserves path tabs and newlines using NUL records", () => {
		const path = "file\twith\nseparators.txt";
		expect(assessAutoMergeDiff([path], raw(path), `2\t1\t${path}\0`)).toEqual({
			kind: "changed",
			paths: [path],
		});
	});
	test("rejects incomplete or contradictory measurements", () => {
		for (const [files, stats] of [
			["", ""],
			[raw("other"), "1\t0\tfile\0"],
			[raw("file"), "1\t0\tother\0"],
			[raw("file"), "1\t0\tfile"],
			["garbage\0file\0", "1\t0\tfile\0"],
		]) {
			expect(assessAutoMergeDiff(["file"], files ?? "", stats ?? "", "reviewed-plan")).toEqual({
				kind: "unreadable",
			});
		}
	});
	test("enforces the file count ceiling only before independent review", () => {
		const paths = Array.from({ length: 101 }, (_, i) => `${i}.ts`);
		const files = paths.map((path) => raw(path)).join("");
		const stats = paths.map((path) => `1\t0\t${path}\0`).join("");
		expect(assessAutoMergeDiff(paths, files, stats)).toMatchObject({
			kind: "unsafe",
			reason: "diff_too_large",
		});
		expect(assessAutoMergeDiff(paths, files, stats, "reviewed-plan")).toEqual({
			kind: "changed",
			paths,
		});
	});
	test("requires manual merge for binary changes even after independent review", () => {
		expect(assessAutoMergeDiff(["image"], raw("image"), "-\t-\timage\0", "reviewed-plan")).toEqual({
			kind: "unsafe",
			reason: "binary_diff",
			paths: ["image"],
		});
	});
	test("rejects removal or conversion of a symlink as well as adding one", () => {
		expect(assessAutoMergeDiff(["link"], raw("link", "120000", "000000"), "0\t1\tlink\0")).toEqual({
			kind: "unsafe",
			reason: "unsupported_file_mode",
			paths: ["link"],
		});
	});
});

describe("structural auto-merge safety against Git", () => {
	test.each(["symlink", "submodule", "large diff"])("checks a real %s change", async (kind) => {
		const fixture = await createGitFixture({ prefix: "factory-diff-risk-", initCommit: "base" });
		try {
			const git = async (...args: string[]) => {
				const result = await fixture.git(args);
				if (result.exitCode !== 0) throw new Error(result.stderr);
				return result.stdout.trim();
			};
			const base = await git("rev-parse", "HEAD");
			await git("checkout", "-qb", "change");
			if (kind === "symlink") {
				await symlink("../outside", join(fixture.path, "link"));
				await git("add", "link");
			} else if (kind === "submodule") {
				await git("update-index", "--add", "--cacheinfo", `160000,${base},vendor/library`);
			} else {
				await writeFile(join(fixture.path, "large.txt"), "line\n".repeat(25_000));
				await git("add", "large.txt");
			}
			await git("commit", "-qm", kind);
			const changedPaths = await computeAutoMergeChangedPaths(exec, fixture.path, base, "HEAD");
			const reviewedPaths = await computeAutoMergeChangedPaths(
				exec,
				fixture.path,
				base,
				"HEAD",
				"reviewed-plan",
			);
			expect(reviewedPaths).toEqual(
				kind === "large diff" ? { kind: "changed", paths: ["large.txt"] } : changedPaths,
			);
			expect(changedPaths.kind).toBe("unsafe");
			const result = decideAutoMerge({
				config: { method: "squash", protectedPaths: [] },
				changedPaths,
				forgeCanArm: true,
				ciFixerRun: false,
			});
			expect(result.decision).toBe("skip");
			if (result.decision === "skip")
				expect(result.reason).toBe(
					kind === "large diff" ? "diff_too_large" : "unsupported_file_mode",
				);
		} finally {
			fixture.cleanup();
		}
	});
});
