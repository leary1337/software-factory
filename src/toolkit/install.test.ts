import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPersonalMcp } from "./install.ts";

describe("personal MCP delivery", () => {
	test("previews then applies idempotently while preserving personal settings", async () => {
		const home = await mkdtemp(join(tmpdir(), "factory-mcp-"));
		try {
			await mkdir(join(home, ".codex"));
			await writeFile(
				join(home, ".codex/config.toml"),
				'# personal comment\nmodel = "personal-model"\n',
			);
			await writeFile(
				join(home, ".claude.json"),
				JSON.stringify({ personal: true, mcpServers: { custom: { command: "custom" } } }),
			);
			expect((await installPersonalMcp(home)).writes).toHaveLength(2);
			expect(await readFile(join(home, ".codex/config.toml"), "utf8")).not.toContain("factory_exa");
			await installPersonalMcp(home, true);
			expect((await installPersonalMcp(home, true)).writes).toEqual([]);
			expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toContain(
				'# personal comment\nmodel = "personal-model"',
			);
			const claude = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
			expect(claude.personal).toBe(true);
			expect(claude.mcpServers.custom.command).toBe("custom");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test("prevents any write when a personal server name conflicts", async () => {
		const home = await mkdtemp(join(tmpdir(), "factory-mcp-"));
		try {
			await mkdir(join(home, ".codex"));
			await writeFile(join(home, ".codex/config.toml"), 'model="personal"\n');
			await writeFile(
				join(home, ".claude.json"),
				JSON.stringify({ mcpServers: { factory_exa: { command: "personal" } } }),
			);
			await expect(installPersonalMcp(home, true)).rejects.toThrow("Preserve personal MCP");
			expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe('model="personal"\n');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test("refuses to overwrite an edited managed configuration", async () => {
		const home = await mkdtemp(join(tmpdir(), "factory-mcp-"));
		try {
			await installPersonalMcp(home, true);
			const path = join(home, ".codex/config.toml");
			const edited = (await readFile(path, "utf8")).replace(
				"startup_timeout_sec = 60",
				"startup_timeout_sec = 90",
			);
			await writeFile(path, edited);
			await expect(installPersonalMcp(home, true)).rejects.toThrow("was edited");
			expect(await readFile(path, "utf8")).toBe(edited);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test("rejects an invalid personal server collection before writing either format", async () => {
		const home = await mkdtemp(join(tmpdir(), "factory-mcp-invalid-"));
		try {
			await mkdir(join(home, ".codex"));
			await writeFile(join(home, ".codex/config.toml"), 'model="personal"\n');
			await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: [] }));
			await expect(installPersonalMcp(home, true)).rejects.toThrow("Invalid Claude MCP");
			expect(await readFile(join(home, ".codex/config.toml"), "utf8")).toBe('model="personal"\n');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	test("removes retired owned servers and preserves user-edited retired servers", async () => {
		const home = await mkdtemp(join(tmpdir(), "factory-mcp-retired-"));
		try {
			await installPersonalMcp(home, true);
			const path = join(home, ".claude.json");
			const receiptPath = join(home, ".agents/factory-mcp.json");
			const config = JSON.parse(await readFile(path, "utf8"));
			const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
			const original = { command: "retired" };
			const fingerprint = createHash("sha256").update(JSON.stringify(original)).digest("hex");
			config.mcpServers.factory_retired = original;
			config.mcpServers.factory_adopted = { command: "personal" };
			receipt.claude.factory_retired = fingerprint;
			receipt.claude.factory_adopted = fingerprint;
			await writeFile(path, JSON.stringify(config));
			await writeFile(receiptPath, JSON.stringify(receipt));
			await installPersonalMcp(home, true);
			const next = JSON.parse(await readFile(path, "utf8"));
			expect(next.mcpServers.factory_retired).toBeUndefined();
			expect(next.mcpServers.factory_adopted).toEqual({ command: "personal" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
