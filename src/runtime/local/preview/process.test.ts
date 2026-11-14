import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxProfile } from "../../../sandbox/types.ts";
import { createGitFixture } from "../../../workspace/git/test-fixture.ts";
import { waitForPreviewProcesses } from "./process.ts";
import { LocalSidecarRegistry } from "./registry.ts";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
async function ready(path: string): Promise<number> {
	for (let i = 0; i < 200; i++) {
		if (await Bun.file(path).exists()) return Number(await readFile(path, "utf8"));
		await Bun.sleep(10);
	}
	throw new Error("Preview did not start");
}

describe.skipIf(process.platform !== "darwin")("native preview processes", () => {
	test("stops one run's descendants and keeps another run alive", async () => {
		const fixture = await createGitFixture({ prefix: "factory-preview-native-" });
		const profileFor = (id: string): SandboxProfile => ({
			workspace: fixture.path,
			home: join(fixture.root, id),
			network: "open",
			readOnlyMounts: [],
			allowedDomains: [],
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: [],
		});
		const registry = new LocalSidecarRegistry({ profileFor });
		try {
			for (const id of ["one", "two"]) {
				await mkdir(profileFor(id).home);
				await registry.create({
					sandboxId: id,
					command: ["/bin/sh", "-c", 'sleep 30 & echo $! > "$HOME/child.pid"; wait'],
				});
			}
			const first = await ready(join(profileFor("one").home, "child.pid"));
			const second = await ready(join(profileFor("two").home, "child.pid"));
			await registry.cascadeDelete("one");
			expect(alive(first)).toBe(false);
			expect(alive(second)).toBe(true);
			expect(await readdir(`${profileFor("one").home}.sidecars`)).toEqual([]);
			await registry.shutdownAll();
			expect(alive(second)).toBe(false);
		} finally {
			await registry.shutdownAll();
			await fixture.cleanup();
		}
	});

	test("waits for each persisted preview marker before recovery removes it", async () => {
		const fixture = await createGitFixture({ prefix: "factory-preview-recovery-" });
		try {
			const home = join(fixture.root, "home");
			await mkdir(`${home}.sidecars`);
			const marker = join(`${home}.sidecars`, "preview.json");
			await writeFile(marker, JSON.stringify({ state: "running" }));
			let settled = false;
			const waiting = waitForPreviewProcesses(home).then(() => {
				settled = true;
			});
			await Bun.sleep(30);
			expect(settled).toBe(false);
			await writeFile(marker, JSON.stringify({ state: "stopped" }));
			await waiting;
			expect(settled).toBe(true);
		} finally {
			await fixture.cleanup();
		}
	});
});
