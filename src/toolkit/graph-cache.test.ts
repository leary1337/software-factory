import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withGraphLock } from "./graph-cache.ts";

describe("graph cache ownership", () => {
	test("serializes competing queries and releases ownership on failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "graph-lock-"));
		const events: string[] = [];
		try {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const first = withGraphLock(root, async () => {
				events.push("start");
				entered.resolve();
				await release.promise;
				events.push("end");
			});
			await entered.promise;
			const second = withGraphLock(root, async () => {
				events.push("next");
			});
			await Bun.sleep(25);
			expect(events).toEqual(["start"]);
			release.resolve();
			await Promise.all([first, second]);
			expect(events).toEqual(["start", "end", "next"]);
			await expect(
				withGraphLock(root, async () => {
					throw new Error("index interrupted");
				}),
			).rejects.toThrow("interrupted");
			expect(await withGraphLock(root, async () => "recovered")).toBe("recovered");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("reclaims the cache after a terminated indexer", async () => {
		const root = await mkdtemp(join(tmpdir(), "graph-lock-"));
		try {
			const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
			await child.exited;
			await mkdir(join(root, "lock"));
			await writeFile(join(root, "lock/owner"), String(child.pid));
			expect(await withGraphLock(root, async () => "current")).toBe("current");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
