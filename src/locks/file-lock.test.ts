import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, withFileLock } from "./file-lock.ts";

describe("withFileLock", () => {
	test("serializes competing asynchronous actions and preserves the lock inode", async () => {
		const root = await mkdtemp(join(tmpdir(), "factory-flock-"));
		const path = join(root, "update.flock");
		try {
			const order: number[] = [];
			await Promise.all([
				withFileLock(path, async () => {
					order.push(1);
					await Bun.sleep(30);
					order.push(2);
				}),
				withFileLock(path, async () => {
					order.push(3);
				}),
			]);
			expect(order).toEqual([1, 2, 3]);
			const inode = (await stat(path)).ino;
			await withFileLock(path, async () => {});
			expect((await stat(path)).ino).toBe(inode);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("releases a killed process owner without stale-file cleanup", async () => {
		const root = await mkdtemp(join(tmpdir(), "factory-flock-death-"));
		const path = join(root, "update.flock");
		const script = `import {acquireFileLock} from ${JSON.stringify(join(import.meta.dir, "file-lock.ts"))}; acquireFileLock(${JSON.stringify(path)}); console.log('locked'); setInterval(()=>{},1000);`;
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		try {
			const reader = child.stdout.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("locked");
			expect(() => acquireFileLock(path)).toThrow("in progress");
			const waiting = withFileLock(path, async () => "recovered", 5000);
			child.kill("SIGKILL");
			await child.exited;
			expect(await waiting).toBe("recovered");
			expect((await stat(path)).isFile()).toBe(true);
		} finally {
			child.kill();
			await child.exited;
			await rm(root, { recursive: true, force: true });
		}
	});
	test("releases ownership when an update fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "factory-flock-failure-"));
		const path = join(root, "update.flock");
		try {
			await expect(
				withFileLock(path, async () => {
					throw new Error("update failed");
				}),
			).rejects.toThrow("update failed");
			const release = acquireFileLock(path);
			release();
			release();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
