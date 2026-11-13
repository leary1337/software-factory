import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import type { ReapExec } from "../runs/reap/types.ts";
import { publishReviewedHead } from "./review-publish.ts";

const execute = promisify(execFile);
let root: string;
let remote: string;
let checkout: string;
let base: string;
let head: string;
const git = async (cwd: string, ...args: string[]) =>
	(await execute("git", args, { cwd })).stdout.trim();
const exec: ReapExec = {
	run: async (command, args, opts) => {
		const env = { ...process.env, ...opts.env };
		for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
		return execute(command, [...args], { cwd: opts.cwd, env });
	},
};
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "warren-cas-test-"));
	remote = join(root, "remote.git");
	checkout = join(root, "checkout");
	await git(root, "init", "--bare", remote);
	await git(root, "clone", remote, checkout);
	await git(checkout, "config", "user.name", "Test");
	await git(checkout, "config", "user.email", "test@example.test");
	await git(checkout, "checkout", "-b", "main");
	await writeFile(join(checkout, "value"), "base");
	await git(checkout, "add", "value");
	await git(checkout, "commit", "-m", "base");
	base = await git(checkout, "rev-parse", "HEAD");
	await git(checkout, "push", "origin", "main");
	await git(checkout, "checkout", "-b", "work");
	await writeFile(join(checkout, "value"), "reviewed");
	await git(checkout, "commit", "-am", "reviewed");
	head = await git(checkout, "rev-parse", "HEAD");
	await git(checkout, "push", "origin", "work");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const publish = (runner = exec) =>
	publishReviewedHead({
		forge: new FakeForge(),
		exec: runner,
		project: { gitUrl: remote, localPath: checkout },
		branch: "work",
		baseBranch: "main",
		head,
		base,
	});

test("publishes exactly the reviewed tree without rewriting ancestry", async () => {
	expect(await publish()).toBe("published");
	expect(await git(remote, "rev-parse", "main")).toBe(head);
	expect(await git(remote, "merge-base", base, "main")).toBe(base);
	expect(await git(remote, "show", "main:value")).toBe("reviewed");
});
test("a concurrent base push immediately before publication is never overwritten", async () => {
	await git(checkout, "checkout", "main");
	await writeFile(join(checkout, "other"), "concurrent");
	await git(checkout, "add", "other");
	await git(checkout, "commit", "-m", "concurrent");
	const concurrent = await git(checkout, "rev-parse", "HEAD");
	const racing: ReapExec = {
		run: async (cmd, args, opts) => {
			if (args.includes("push")) await git(checkout, "push", "origin", "main");
			return exec.run(cmd, args, opts);
		},
	};
	expect(await publish(racing)).toBe("stale_base");
	expect(await git(remote, "rev-parse", "main")).toBe(concurrent);
});
test("recovers a lost acknowledgement by reading the expected published SHA", async () => {
	const lost: ReapExec = {
		run: async (cmd, args, opts) => {
			const result = await exec.run(cmd, args, opts);
			if (args.includes("push")) throw new Error("lost response with secret");
			return result;
		},
	};
	expect(await publish(lost)).toBe("published");
	expect(await git(remote, "rev-parse", "main")).toBe(head);
});
test("rejects a new unreviewed head without changing main", async () => {
	await git(checkout, "commit", "--allow-empty", "-m", "unreviewed");
	await git(checkout, "push", "origin", "work");
	expect(await publish()).toBe("stale_head");
	expect(await git(remote, "rev-parse", "main")).toBe(base);
});
