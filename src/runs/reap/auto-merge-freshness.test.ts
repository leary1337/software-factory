import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureGitOrThrow, mkdtempOutsideRepo } from "../../workspace/git/test-fixture.ts";
import { readAutoMergeSnapshot } from "./auto-merge-snapshot.ts";
import { fakeForge, TEST_REPO_REF } from "./test-helpers.ts";

test("invalidates a checked head when the remote base advances without a textual conflict", async () => {
	const root = mkdtempOutsideRepo("merge-freshness-");
	const remote = join(root, "remote");
	const git = async (...args: string[]) =>
		(
			await fixtureGitOrThrow(remote, [
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@warren.invalid",
				...args,
			])
		).stdout.trim();
	try {
		await mkdir(remote);
		await git("init", "-b", "main");
		await mkdir(join(remote, ".warren"));
		await writeFile(join(remote, ".warren/config.yaml"), "pr:\n  autoMerge:\n    method: squash\n");
		await writeFile(join(remote, "api.txt"), "v1\n");
		await git("add", ".");
		await git("commit", "-m", "base");
		const base = await git("rev-parse", "HEAD");
		await git("checkout", "-b", "work");
		await writeFile(join(remote, "consumer.txt"), "uses v1\n");
		await git("add", ".");
		await git("commit", "-m", "consumer");
		const head = await git("rev-parse", "HEAD");
		const snapshot = () =>
			readAutoMergeSnapshot({
				projectAutoMerge: undefined,
				run: { id: "review" },
				project: { gitUrl: remote, localPath: join(root, "host") },
				prUrl: "fake://x/y/pulls/1",
				prNumber: 1,
				repoRef: TEST_REPO_REF,
				prRef: { forge: "fake", key: "x/y#1", number: 1, webUrl: "fake://x/y/pulls/1" },
				branch: "work",
				baseBranch: "main",
				workspacePath: null,
				forge: fakeForge(),
				exec: { run: (_cmd, args, opts) => fixtureGitOrThrow(opts.cwd, [...args]) },
				emit: async () => {},
			});
		expect(await snapshot()).toMatchObject({
			baseCommit: base,
			headCommit: head,
			baseIsAncestor: true,
		});
		await git("checkout", "main");
		await writeFile(join(remote, "api.txt"), "v2\n");
		await git("commit", "-am", "incompatible api without conflicting lines");
		const advanced = await git("rev-parse", "HEAD");
		expect(await snapshot()).toMatchObject({
			baseCommit: advanced,
			headCommit: head,
			baseIsAncestor: false,
		});
		await git("checkout", "work");
		await git("merge", "main", "--no-edit");
		expect(await snapshot()).toMatchObject({ baseCommit: advanced, baseIsAncestor: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
