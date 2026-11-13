import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGitOrThrow } from "../../workspace/git/test-fixture.ts";
import type { RunHandle } from "../contract.ts";
import { LocalProvider } from "./provider.ts";

const auth = (token: string) =>
	JSON.stringify({
		auth_mode: "chatgpt",
		tokens: {
			account_id: "fixture",
			access_token: token,
			refresh_token: "test-refresh",
		},
	});
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

for (const signal of ["SIGTERM", "SIGKILL"] as const) {
	test.skipIf(process.platform !== "darwin")(
		`recovers work and rotated credentials after ${signal} without orphan processes`,
		async () => {
			const root = await realpath(await mkdtemp(join(tmpdir(), "factory-process-")));
			let owner: Bun.Subprocess | undefined;
			let childPid: number | undefined;
			try {
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
				await writeFile(join(root, "auth.json"), auth("original"), { mode: 0o600 });
				await mkdir(join(root, "bin"));
				const shim = join(root, "bin/codex");
				await writeFile(
					shim,
					`#!/bin/sh\nset -e\nprintf '%s' '${auth("rotated")}' > "$HOME/.codex/auth.json"\necho committed > committed.txt\ngit add committed.txt\ngit commit -m work\necho pending > pending.txt\necho $$ > ready.pid\nsleep 30 &\necho $! > descendant.pid\nwait\n`,
				);
				await chmod(shim, 0o700);
				owner = Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, "../../server/main/fixtures/recovery-owner.ts"),
						root,
					],
					{
						env: {
							...process.env,
							PATH: `${join(root, "bin")}:${process.env.PATH}`,
							WARREN_CODEX_AUTH_FILE: join(root, "auth.json"),
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				for (
					let i = 0;
					i < 300 &&
					!(await Bun.file(join(root, "ready.json")).exists()) &&
					owner.exitCode === null;
					i++
				)
					await Bun.sleep(20);
				if (!(await Bun.file(join(root, "ready.json")).exists()))
					throw new Error(await new Response(owner.stderr as ReadableStream<Uint8Array>).text());
				const { handle, pid, descendant } = JSON.parse(
					await readFile(join(root, "ready.json"), "utf8"),
				) as {
					handle: RunHandle;
					pid: number;
					descendant: number;
				};
				childPid = pid;
				owner.kill(signal);
				await owner.exited;
				for (let i = 0; i < 250 && alive(pid); i++) await Bun.sleep(20);
				expect(alive(pid)).toBe(false);
				expect(alive(descendant)).toBe(false);
				expect(await Bun.file(join(root, "stopped")).exists()).toBe(signal === "SIGTERM");
				expect(await readFile(join(root, "auth.json"), "utf8")).toBe(
					auth(signal === "SIGTERM" ? "rotated" : "original"),
				);
				const provider = new LocalProvider({ serverEnv: { WARREN_DATA_DIR: join(root, "data") } });
				const result = await provider.terminate(handle);
				expect(result.archived).toBe(true);
				expect(await readFile(join(root, "auth.json"), "utf8")).toBe(auth("rotated"));
				const restored = join(root, "restored");
				await fixtureGitOrThrow(root, [
					"clone",
					"-b",
					"warren-recovery",
					result.recoveryPath ?? "missing",
					restored,
				]);
				expect(await readFile(join(restored, "committed.txt"), "utf8")).toBe("committed\n");
				expect(await readFile(join(restored, "pending.txt"), "utf8")).toBe("pending\n");
				await provider.terminate(handle);
				expect(await Bun.file(result.recoveryPath ?? "missing").exists()).toBe(true);
			} finally {
				owner?.kill();
				await owner?.exited;
				if (childPid && alive(childPid)) {
					try {
						process.kill(-childPid, "SIGKILL");
					} catch {}
				}
				await rm(root, { recursive: true, force: true });
			}
		},
		15_000,
	);
}
