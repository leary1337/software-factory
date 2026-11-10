import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxed } from "./sandbox.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("Seatbelt browser tests", () => {
	test.skipIf(process.platform !== "darwin" || !existsSync(CHROME))(
		"runs Playwright in an isolated HOME while keeping host files private",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "warren-chrome-"));
			const privateFile = join(homedir(), `.warren-chrome-probe-${crypto.randomUUID()}`);
			const home = join(root, "home");
			const workspace = join(root, "workspace");
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: () =>
					new Response("<button onclick=\"this.textContent='BROWSER_OK'\">Go</button>", {
						headers: { "content-type": "text/html" },
					}),
			});
			try {
				await mkdir(home);
				await mkdir(workspace);
				await writeFile(privateFile, "private host data");
				await writeFile(
					join(workspace, "browser.cjs"),
					`
const { chromium } = require(${JSON.stringify(require.resolve("@playwright/test"))});
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.env.PLAYWRIGHT_MCP_SANDBOX, 'false');
assert.throws(() => fs.readFileSync(${JSON.stringify(privateFile)}), /EPERM|EACCES/);
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:${server.port}');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    assert.equal(await page.getByRole('button').textContent(), 'BROWSER_OK');
    await page.screenshot({ path: 'browser.png' });
    console.log('BROWSER_OK');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
				);
				const proc = await runSandboxed(
					{
						workspace,
						home,
						network: "restricted",
						allowedDomains: [],
						proxyAddress: { host: "127.0.0.1", port: server.port ?? 0 },
						readOnlyMounts: [join(import.meta.dir, "../../node_modules")],
						toolchainPaths: ["/opt/homebrew/bin"],
						envPassthrough: [],
						setEnv: { TMPDIR: home },
					},
					{ argv: [Bun.which("node") ?? "node", "browser.cjs"] },
				);
				const timer = setTimeout(() => proc.cancel(), 15000);
				try {
					const [stdout, stderr, code] = await Promise.all([
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
						proc.exited,
					]);
					expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
					expect(stdout.trim()).toBe("BROWSER_OK");
					expect(existsSync(join(workspace, "browser.png"))).toBe(true);
				} finally {
					clearTimeout(timer);
					proc.cancel();
				}
			} finally {
				server.stop(true);
				await rm(root, { recursive: true, force: true });
				await rm(privateFile, { force: true });
			}
		},
		20000,
	);
});
