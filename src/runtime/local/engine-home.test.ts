import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEngine } from "./engine.ts";
import { LocalRunStore } from "./run-store.ts";

test("terminate waits for drive cleanup before removing credentials", async () => {
	const data = await mkdtemp(join(tmpdir(), "engine-home-"));
	try {
		const home = join(data, "home");
		await mkdir(home);
		const auth = join(home, "auth.json");
		await writeFile(auth, "fake-rotated-token");
		const store = new LocalRunStore();
		const record = store.create({
			runId: "run-home",
			sandboxId: "local-home",
			workspacePath: join(data, "workspace"),
			homePath: home,
			branch: "test",
		});
		const engine = new LocalEngine({ serverEnv: { WARREN_DATA_DIR: data }, store });
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let saved = "";
		record.driveDone = held.then(async () => {
			saved = await readFile(auth, "utf8");
		});
		const terminated = engine.terminate({
			runId: "run-home",
			sandboxId: "local-home",
			providerRunId: "run-home",
		});
		await Bun.sleep(20);
		expect(await Bun.file(auth).exists()).toBe(true);
		expect(record.cancelRequested).toBe(true);
		release();
		await terminated;
		expect(saved).toBe("fake-rotated-token");
		expect(await Bun.file(auth).exists()).toBe(false);
	} finally {
		await rm(data, { recursive: true, force: true });
	}
});
