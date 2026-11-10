import { expect, test } from "bun:test";
import type { Repos } from "../db/repos/index.ts";
import type { Forge } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import type { AutoMergeSnapshot } from "../runs/reap/auto-merge-snapshot.ts";
import {
	createReviewChangedPathsReader,
	createReviewedMerge,
	createReviewHeadReader,
} from "./review-forge.ts";

const SHA = "a".repeat(40);
async function harness(snapshot: Partial<AutoMergeSnapshot> = {}, head = SHA) {
	const fake = new FakeForge();
	fake.setAutoMergeArmCapability(true);
	const forge: Forge = fake;
	const ref = { forge: "fake", key: "o/r" };
	const opened = await forge.openPullRequest(ref, {
		title: "Work",
		body: "",
		headBranch: "work",
		baseBranch: "main",
	});
	if (!opened.ok) throw new Error("fixture");
	const calls: Parameters<Forge["mergePullRequest"]>[2][] = [];
	forge.getPullRequest = async () => ({
		ok: true,
		value: {
			lifecycle: "open",
			mergedAt: null,
			headCommit: head,
			baseBranch: "main",
			autoMerge: "unarmed",
		},
	});
	forge.mergePullRequest = async (_ref, _pr, options) => {
		calls.push(options);
		return { ok: true, value: undefined };
	};
	const merge = createReviewedMerge({
		forge,
		repos: {
			projects: { require: async () => ({ gitUrl: "fake://o/r", localPath: "/tmp/review" }) },
		} as unknown as Pick<Repos, "projects">,
		exec: {
			run: async () => {
				throw new Error("unexpected git");
			},
		},
		readSnapshot: async () => ({
			config: { method: "squash", protectedPaths: ["private/"] },
			headCommit: SHA,
			changedPaths: { kind: "changed", paths: ["safe.ts"] },
			...snapshot,
		}),
	});
	return { merge: () => merge(opened.value.webUrl, "work", SHA, "p"), calls, forge };
}

test("merges only the reviewed head with the shared base policy", async () => {
	const h = await harness();
	expect(await h.merge()).toBe(true);
	expect(h.calls).toEqual([{ expectedHead: SHA, method: "squash" }]);
});

test("blocks protected paths, absent policy, changed config and changed snapshot head", async () => {
	const cases: Partial<AutoMergeSnapshot>[] = [
		{ config: undefined },
		{ changedPaths: { kind: "changed", paths: ["private/key"] } },
		{ changedPaths: { kind: "changed", paths: [".warren/config.yaml"] } },
		{ changedPaths: { kind: "unreadable" } },
		{ headCommit: "b".repeat(40) },
	];
	for (const snapshot of cases) {
		const h = await harness(snapshot);
		expect(await h.merge()).toBe(false);
		expect(h.calls).toHaveLength(0);
	}
	const pushed = await harness({}, "b".repeat(40));
	expect(await pushed.merge()).toBe(false);
	expect(pushed.calls).toHaveLength(0);
});

test("recognizes a previously merged commit without another merge write", async () => {
	const h = await harness();
	h.forge.getPullRequest = async () => ({
		ok: true,
		value: {
			lifecycle: "merged",
			mergedAt: Date.now(),
			headCommit: SHA,
			baseBranch: "main",
			autoMerge: "unarmed",
		},
	});
	expect(await h.merge()).toBe(true);
	expect(h.calls).toHaveLength(0);
});

test("reads only complete SHA values from a resolvable pull request", async () => {
	const h = await harness();
	const read = createReviewHeadReader(h.forge);
	expect(await read("fake://o/r/pulls/1")).toBe(SHA);
	expect(await read("https://elsewhere.example/pr/1")).toBeNull();
	h.forge.getPullRequest = async () => ({
		ok: true,
		value: {
			lifecycle: "open",
			mergedAt: null,
			headCommit: "short",
			baseBranch: "main",
			autoMerge: "unarmed",
		},
	});
	expect(await read("fake://o/r/pulls/1")).toBeNull();
	h.forge.getPullRequest = async () => ({
		ok: false,
		error: { kind: "network", detail: "offline" },
	});
	expect(await read("fake://o/r/pulls/1")).toBeNull();
});

test("reads UI review paths only from the pinned remote snapshot", async () => {
	const h = await harness();
	let snapshot: AutoMergeSnapshot = {
		config: undefined,
		headCommit: SHA,
		changedPaths: { kind: "changed", paths: ["view.tsx"] },
	};
	const read = createReviewChangedPathsReader({
		forge: h.forge,
		repos: {
			projects: { require: async () => ({ gitUrl: "fake://o/r", localPath: "/tmp/review" }) },
		} as unknown as Pick<Repos, "projects">,
		exec: {
			run: async () => {
				throw new Error("unexpected git");
			},
		},
		readSnapshot: async () => snapshot,
	});
	expect(await read("fake://o/r/pulls/1", "work", "p", SHA)).toEqual(["view.tsx"]);
	snapshot = {
		...snapshot,
		changedPaths: { kind: "unsafe", reason: "binary_diff", paths: ["image.png"] },
	};
	expect(await read("fake://o/r/pulls/1", "work", "p", SHA)).toEqual([]);
	snapshot = { ...snapshot, headCommit: "b".repeat(40) };
	expect(await read("fake://o/r/pulls/1", "work", "p", SHA)).toBeNull();
	snapshot = { ...snapshot, headCommit: SHA, changedPaths: { kind: "unreadable" } };
	expect(await read("fake://o/r/pulls/1", "work", "p", SHA)).toBeNull();
});
