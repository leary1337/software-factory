import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitOrThrow } from "../../workspace/git/test-fixture.ts";
import { prepareCodexCredentials } from "../adapters/codex-credentials.ts";
import type { AgentRuntimeAdapter } from "../adapters/types.ts";
import { LocalProvider } from "./provider.ts";
import { LocalRunStore } from "./run-store.ts";

const auth = (token: string) =>
	JSON.stringify({
		auth_mode: "chatgpt",
		tokens: { account_id: "fixture", access_token: token, refresh_token: "test-refresh" },
	});

test.skipIf(process.platform !== "darwin")(
	"cancel drains the real sandbox and saves rotated credentials before returning",
	async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "factory-cancel-")));
		const store = new LocalRunStore();
		const source = join(root, "auth.json");
		const adapter: AgentRuntimeAdapter = {
			runtimeId: "fixture",
			harnessStatePrefixes: [],
			terminalErrorEnvelopeTypes: [],
			prepareHome: (home: string) => prepareCodexCredentials(home, source),
			buildSpawnCommand: () => ({
				argv: [
					"/bin/sh",
					"-c",
					`printf '%s' '${auth("rotated")}' > "$HOME/.codex/auth.json"; echo committed > committed.txt; git add committed.txt; git commit -m work; echo pending > pending.txt; echo $$ > ready.pid; sleep 30`,
				],
			}),
		} as unknown as AgentRuntimeAdapter;
		const provider = new LocalProvider({
			serverEnv: { WARREN_DATA_DIR: join(root, "data") },
			store,
			drive: { registry: { get: () => adapter } },
		});
		let handle: Awaited<ReturnType<typeof provider.create>> | undefined;
		try {
			await writeFile(source, auth("original"), { mode: 0o600 });
			const host = join(root, "host");
			await fixtureGitOrThrow(root, ["init", "-b", "main", host]);
			await fixtureGitOrThrow(host, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"--allow-empty",
				"-m",
				"init",
			]);
			handle = await provider.create({
				runId: "cancel-cleanup",
				originUrl: host,
				branch: "test/cancel",
				baseBranch: "main",
				hostClonePathHint: host,
				runtimeId: "fixture",
				prompt: "wait",
				network: "none",
				env: {},
				mode: "batch",
				seedFiles: [],
			});
			const record = store.getByRunId(handle.providerRunId);
			if (!record) throw new Error("missing run");
			for (
				let i = 0;
				i < 250 && !(await Bun.file(join(record.workspacePath, "ready.pid")).exists());
				i++
			)
				await Bun.sleep(20);
			expect(await Bun.file(join(record.workspacePath, "ready.pid")).exists()).toBe(true);
			expect(await readFile(join(record.homePath, ".codex/auth.json"), "utf8")).toBe(
				auth("rotated"),
			);
			await provider.cancel(handle);
			const atReturn = await readFile(source, "utf8");
			await record.driveDone;
			expect(await readFile(source, "utf8")).toBe(auth("rotated"));
			expect(atReturn).toBe(auth("rotated"));
			expect(await Bun.file(join(record.homePath, ".codex/auth.json")).exists()).toBe(false);
			// A restarted provider only has the durable manifest, not the old store.
			const restarted = new LocalProvider({ serverEnv: { WARREN_DATA_DIR: join(root, "data") } });
			await writeFile(join(root, "data/recovery"), "simulate an unavailable archive directory");
			await expect(restarted.terminate(handle)).rejects.toThrow();
			expect(await Bun.file(join(record.workspacePath, "pending.txt")).exists()).toBe(true);
			await rm(join(root, "data/recovery"));
			const result = await restarted.terminate(handle);
			expect(result.archived).toBe(true);
			const restored = join(root, "restored");
			await fixtureGitOrThrow(root, [
				"clone",
				"-b",
				"warren-recovery",
				join(root, "data/recovery/cancel-cleanup.bundle"),
				restored,
			]);
			expect(await readFile(join(restored, "committed.txt"), "utf8")).toBe("committed\n");
			expect(await readFile(join(restored, "pending.txt"), "utf8")).toBe("pending\n");
		} finally {
			if (handle) await provider.terminate(handle);
			await rm(root, { recursive: true, force: true });
		}
	},
	10_000,
);
