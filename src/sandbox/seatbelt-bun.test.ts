import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed } from "./sandbox.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("seatbelt Bun script execution", () => {
	test.skipIf(process.platform !== "darwin")(
		"allows Bun to traverse workspace ancestors",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "seatbelt-bun-"));
			dirs.push(root);
			const workspace = join(root, "workspace");
			const home = join(root, "home");
			await mkdir(workspace);
			await mkdir(home);
			await writeFile(
				join(workspace, "package.json"),
				JSON.stringify({ scripts: { verify: "echo BUN_OK" } }),
			);
			const proc = await runSandboxed(
				{
					workspace,
					home,
					network: "none",
					readOnlyMounts: [],
					allowedDomains: [],
					envPassthrough: [],
					setEnv: {},
					toolchainPaths: [],
					timeoutMs: 5000,
				},
				{ argv: [process.execPath, "run", "verify"] },
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect({ code, stderr }).toEqual({ code: 0, stderr: "$ echo BUN_OK\n" });
			expect(stdout).toBe("BUN_OK\n");
		},
	);
});
