import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_RUNTIME_ID } from "../../../runtime/adapters/codex.ts";
import { resolveLocalBootBackend } from "../../../runtime/local/boot-backend.ts";
import { serveUntilSignal } from "../shutdown.ts";

const root = process.argv[2];
if (!root) throw new Error("fixture root required");
await serveUntilSignal(async () => {
	const backend = resolveLocalBootBackend({ WARREN_DATA_DIR: join(root, "data") });
	const handle = await backend.runtimeProvider.create({
		runId: "recovery-process",
		originUrl: join(root, "host"),
		branch: "test/recovery",
		baseBranch: "main",
		hostClonePathHint: join(root, "host"),
		runtimeId: CODEX_RUNTIME_ID,
		prompt: "wait",
		network: "none",
		env: {},
		mode: "batch",
		seedFiles: [],
	});
	const workspace = join(root, "data/local/workspaces", handle.sandboxId);
	for (let i = 0; i < 250; i++) {
		try {
			const pid = Number(await readFile(join(workspace, "ready.pid"), "utf8"));
			await writeFile(
				join(root, "ready.json"),
				JSON.stringify({
					handle,
					pid,
					descendant: Number(await readFile(join(workspace, "descendant.pid"), "utf8")),
				}),
			);
			return {
				stop: async () => {
					await backend.close();
					await writeFile(join(root, "stopped"), "yes");
				},
			};
		} catch {
			await Bun.sleep(20);
		}
	}
	await backend.close();
	throw new Error("fixture sandbox did not become ready");
});
