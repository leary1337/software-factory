/** Built-in Seeds tracker contract: idempotent close, missing IDs and status normalization. */
import { describe, expect, test } from "bun:test";

import { IssueNotFoundError, type TrackerContext, TrackerError } from "../core/wire-tracker.ts";
import type { SpawnFn } from "../projects/clone.ts";
import { SeedsTracker } from "./seeds-tracker.ts";

const CTX: TrackerContext = { projectId: "proj-1", localPath: "/data/projects/x/y" };

/**
 * A stateful fake `sd`: the minimum seeds CLI surface SeedsTracker
 * exercises (`show --json`, `list --format json`, `close`), backed by
 * an in-memory id → status map with real seeds semantics — close is
 * idempotent, unknown ids exit 1 with the not-found spelling.
 */
function fakeSd(initial: Readonly<Record<string, string>>): SpawnFn {
	const statuses = new Map(Object.entries(initial));
	return async (cmd) => {
		const [, sub, a1] = cmd;
		if (sub === "show") {
			const id = a1 as string;
			const status = statuses.get(id);
			if (status === undefined) {
				return { stdout: "", stderr: `seeds: Issue not found: ${id}`, exitCode: 1 };
			}
			return {
				stdout: JSON.stringify({ success: true, issue: { id, status } }),
				stderr: "",
				exitCode: 0,
			};
		}
		if (sub === "list") {
			return {
				stdout: JSON.stringify({
					success: true,
					issues: [...statuses.entries()].map(([id, status]) => ({ id, status })),
				}),
				stderr: "",
				exitCode: 0,
			};
		}
		if (sub === "close") {
			const id = a1 as string;
			if (!statuses.has(id)) {
				return { stdout: "", stderr: `seeds: Issue not found: ${id}`, exitCode: 1 };
			}
			statuses.set(id, "closed");
			return { stdout: "", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: `unexpected sd invocation: ${cmd.join(" ")}`, exitCode: 2 };
	};
}

function tracker(spawn: SpawnFn): SeedsTracker {
	return new SeedsTracker({ spawn, sdBinary: "sd" });
}

describe("SeedsTracker conformance parity (suite semantic subset)", () => {
	test("issues/close-idempotent: closing twice succeeds; close flips the status", async () => {
		const t = tracker(fakeSd({ "warren-a": "open" }));
		await t.closeIssue(CTX, "warren-a");
		expect((await t.getIssue(CTX, "warren-a")).status).toBe("closed");
		// The contract: an already-closed close is a success, not an error.
		await t.closeIssue(CTX, "warren-a");
		expect((await t.getIssue(CTX, "warren-a")).status).toBe("closed");
	});

	test("errors/issue-read-not-found: a missing id throws IssueNotFoundError, not TrackerError", async () => {
		const t = tracker(fakeSd({}));
		let caught: unknown;
		try {
			await t.getIssue(CTX, "warren-missing");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(IssueNotFoundError);
	});

	test("errors/issue-close-not-found: closing a missing id throws IssueNotFoundError", async () => {
		const t = tracker(fakeSd({}));
		let caught: unknown;
		try {
			await t.closeIssue(CTX, "warren-missing");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(IssueNotFoundError);
		// Belt + braces: the taxonomy must not collapse to the generic case.
		expect(Object.getPrototypeOf(caught).constructor).not.toBe(TrackerError);
	});

	test("issues/status-normalization: raw statuses fold onto open/closed/other", async () => {
		const t = tracker(
			fakeSd({ "warren-open": "open", "warren-wip": "in_progress", "warren-done": "closed" }),
		);
		expect((await t.getIssue(CTX, "warren-open")).status).toBe("open");
		expect((await t.getIssue(CTX, "warren-wip")).status).toBe("other");
		expect((await t.getIssue(CTX, "warren-done")).status).toBe("closed");
	});

	test("issues/close-status-consistency: the issue read and the status map agree after close", async () => {
		const t = tracker(fakeSd({ "warren-a": "open", "warren-b": "open" }));
		await t.closeIssue(CTX, "warren-a");
		const issue = await t.getIssue(CTX, "warren-a");
		const statuses = await t.listIssueStatuses(CTX);
		expect(statuses.get("warren-a")).toBe(issue.status);
		expect(statuses.get("warren-b")).toBe("open");
	});
});
