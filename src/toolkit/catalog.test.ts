import { describe, expect, test } from "bun:test";
import {
	claudeToolkitConfig,
	codexToolkitArguments,
	TOOLKIT,
	TOOLKIT_VERSION,
	toolkitServers,
} from "./catalog.ts";
import { callFreeRemote, missingEvidenceDecision, RemoteToolError } from "./remote.ts";

describe("toolkit catalog", () => {
	test("projects the same anonymous free tools into both harnesses", () => {
		const servers = toolkitServers("/project");
		expect(Object.keys(JSON.parse(claudeToolkitConfig("/project")).mcpServers)).toEqual(
			Object.keys(servers),
		);
		expect(TOOLKIT_VERSION).toMatch(/^[a-f0-9]{64}$/);
		expect(TOOLKIT.exa.tools).toEqual(["web_search_exa", "web_fetch_exa"]);
		expect(TOOLKIT.graphify.backend).toBe("none");
		const args = codexToolkitArguments("/project").join(" ");
		expect(args).toContain('enabled_tools=["web_search_exa","web_fetch_exa"]');
		expect(args).not.toMatch(/API_KEY|bearer_token|Authorization|latest/);
		expect(servers.factory_playwright?.args).toContain("--isolated");
	});
	test("refuses a tool outside the free allowlist before any request", async () => {
		await expect(callFreeRemote("exa", "tools/call", { name: "agent_run" })).rejects.toThrow(
			"outside the free catalog",
		);
	});
	test("distinguishes quota from an unavailable service without leaking its response", async () => {
		for (const [status, availability] of [
			[429, "quota"],
			[503, "unavailable"],
		] as const) {
			const fake = async () => new Response("private diagnostic text", { status });
			try {
				await callFreeRemote("exa", "tools/list", {}, fake);
				throw new Error("Expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(RemoteToolError);
				expect((error as RemoteToolError).availability).toBe(availability);
				expect(String(error)).not.toContain("private diagnostic");
			}
		}
	});
	test("requires alternative evidence before continuing without a tool", () => {
		expect(missingEvidenceDecision("quota", true)).toBe("continue");
		expect(missingEvidenceDecision("unavailable", false)).toBe("blocked");
	});
});

describe("browser process configuration", () => {
	test("uses short private sockets and keeps browser artifacts outside the repository", () => {
		const home = `/tmp/${"long-run-home/".repeat(20)}`;
		const browser = toolkitServers("/project", undefined, home).factory_playwright;
		expect(browser?.env?.PWTEST_SOCKETS_DIR?.length).toBeLessThan(40);
		expect(browser?.args).toContain(`${home}.cache/factory/playwright`);
		expect(browser?.args?.join(" ")).not.toContain("/project");
	});
	test("classifies a successful HTTP response containing an MCP quota error", async () => {
		const fake = async () =>
			Response.json({
				jsonrpc: "2.0",
				result: { isError: true, content: [{ type: "text", text: "rate limit exceeded" }] },
			});
		try {
			await callFreeRemote("exa", "tools/list", {}, fake);
			throw new Error("expected quota");
		} catch (error) {
			expect(error).toBeInstanceOf(RemoteToolError);
			expect((error as RemoteToolError).availability).toBe("quota");
		}
	});
});
