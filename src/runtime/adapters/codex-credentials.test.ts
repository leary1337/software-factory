import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "./codex.ts";
import { codexAuthFile, prepareCodexCredentials } from "./codex-credentials.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function auth(token: string, account = "test-account") {
	return JSON.stringify({
		auth_mode: "chatgpt",
		tokens: { account_id: account, access_token: token, refresh_token: "test-refresh" },
	});
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "codex-auth-test-"));
	dirs.push(root);
	const source = join(root, "source.json");
	const home = join(root, "home");
	await writeFile(source, auth("old"), { mode: 0o600 });
	return { source, home, target: join(home, ".codex/auth.json") };
}

describe("prepareCodexCredentials", () => {
	test("delivers auth and skills through the adapter and removes only the run credential", async () => {
		const { source, home, target } = await fixture();
		const prior = process.env.WARREN_CODEX_AUTH_FILE;
		try {
			process.env.WARREN_CODEX_AUTH_FILE = source;
			expect(codexAuthFile()).toBe(source);
			const finish = await codexAdapter.prepareHome?.(home);
			expect(await readFile(target, "utf8")).toBe(auth("old"));
			expect(await Bun.file(join(home, ".agents/skills/tdd/SKILL.md")).exists()).toBe(true);
			await finish?.();
			expect(await Bun.file(target).exists()).toBe(false);
			expect(await readFile(source, "utf8")).toBe(auth("old"));
		} finally {
			if (prior === undefined) delete process.env.WARREN_CODEX_AUTH_FILE;
			else process.env.WARREN_CODEX_AUTH_FILE = prior;
		}
	});

	test("forwards only the login with private permissions and persists token rotation", async () => {
		const { source, home, target } = await fixture();
		const finish = await prepareCodexCredentials(home, source);
		expect((await stat(target)).mode & 0o777).toBe(0o600);
		await writeFile(target, auth("refreshed"));
		await finish();
		expect(await readFile(source, "utf8")).toBe(auth("refreshed"));
		expect(await Bun.file(target).exists()).toBe(false);
	});

	test("preserves a newer host login and rejects account substitution", async () => {
		const { source, home, target } = await fixture();
		const finish = await prepareCodexCredentials(home, source);
		await writeFile(source, auth("new-host-login"));
		await writeFile(target, auth("run-refresh"));
		await finish();
		expect(await readFile(source, "utf8")).toBe(auth("new-host-login"));
		const finishAgain = await prepareCodexCredentials(home, source);
		await writeFile(target, auth("other-token", "other-account"));
		await finishAgain();
		expect(await readFile(source, "utf8")).toBe(auth("new-host-login"));
	});

	test("rejects API auth, missing login and symlinked sandbox credentials", async () => {
		const { source, home, target } = await fixture();
		await expect(prepareCodexCredentials(home, `${source}.missing`)).rejects.toThrow(
			"login is unavailable",
		);
		await writeFile(
			source,
			JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fake-test-key" }),
		);
		await expect(prepareCodexCredentials(home, source)).rejects.toThrow("requires a ChatGPT login");
		await writeFile(source, auth("old"));
		const finish = await prepareCodexCredentials(home, source);
		await rm(target);
		await symlink(source, target);
		await expect(finish()).rejects.toThrow();
		expect(await readFile(source, "utf8")).toBe(auth("old"));
	});

	test("rejects a replaced home without reading or deleting its target", async () => {
		const { source, home, target } = await fixture();
		const finish = await prepareCodexCredentials(home, source);
		await rename(join(home, ".codex"), join(home, "moved"));
		await symlink(join(home, "moved"), join(home, ".codex"));
		await expect(finish()).rejects.toThrow("home was replaced");
		expect(await readFile(target, "utf8")).toBe(auth("old"));
		expect(await readFile(source, "utf8")).toBe(auth("old"));
	});

	test("leases a login to one run and releases it after cleanup", async () => {
		const { source, home } = await fixture();
		const finish = await prepareCodexCredentials(home, source);
		await expect(prepareCodexCredentials(`${home}-other`, source)).rejects.toThrow(
			"already in use",
		);
		await finish();
		await finish();
		await (await prepareCodexCredentials(`${home}-other`, source))();
	});

	test("redacts malformed credential contents from errors", async () => {
		const { source, home } = await fixture();
		await writeFile(source, "secret-that-is-not-json");
		await expect(prepareCodexCredentials(home, source)).rejects.toThrow(
			"Codex auth file is not valid JSON; run codex login again",
		);
	});
});
