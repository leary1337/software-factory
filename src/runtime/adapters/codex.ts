import { join } from "node:path";
import { prepareBrowserSockets } from "../../toolkit/browser-sockets.ts";
import { codexToolkitArguments, TOOLKIT_POLICY } from "../../toolkit/catalog.ts";
import { resolveToolkitBundle, toolkitSkillPack } from "../../toolkit/versions.ts";
import { FACTORY_SKILL_POLICY } from "../local/skill-catalog.ts";
import { materializeCodexSkillPack } from "../local/skill-pack.ts";
import { CODEX_DEFAULT_MODEL } from "./codex-config.ts";
import { prepareCodexCredentials, recoverCodexCredentials } from "./codex-credentials.ts";
import { createCodexParser } from "./parsers/codex.ts";
import type { AgentRuntimeAdapter } from "./types.ts";

export const CODEX_RUNTIME_ID = "codex";
export const CODEX_BIN = "codex";

export const codexAdapter: AgentRuntimeAdapter = {
	runtimeId: CODEX_RUNTIME_ID,
	defaultTimeoutMs: 20 * 60_000,
	harnessStatePrefixes: [".codex/sessions/"],
	commitExcludes: [".codex/auth.json", ".codex/sessions/"],
	terminalErrorEnvelopeTypes: [],
	createEventParser: createCodexParser,
	recoverHome: recoverCodexCredentials,
	async prepareHome(homePath, frontmatter) {
		await materializeCodexSkillPack(
			homePath,
			await toolkitSkillPack(frontmatter?.toolkitVersion),
			frontmatter?.toolkitVersion
				? resolveToolkitBundle(frontmatter.toolkitVersion).catalog.playwright.cliVersion
				: undefined,
		);
		const clearSockets = await prepareBrowserSockets(homePath);
		try {
			const releaseCredentials = await prepareCodexCredentials(homePath);
			return async () => {
				try {
					await releaseCredentials();
				} finally {
					await clearSockets();
				}
			};
		} catch (error) {
			await clearSockets();
			throw error;
		}
	},
	buildSpawnCommand(ctx) {
		if (ctx.frontmatter?.provider && ctx.frontmatter.provider !== "openai")
			throw new Error("Codex ChatGPT runs require the openai provider");
		const home = process.platform === "linux" ? "/home/sandbox" : ctx.homePath;
		return {
			argv: [
				"codex",
				"exec",
				"--json",
				"--ignore-user-config",
				// The operator approved trusted host execution without a system sandbox.
				"--dangerously-bypass-approvals-and-sandbox",
				"-c",
				'forced_login_method="chatgpt"',
				"-c",
				'cli_auth_credentials_store="file"',
				"-c",
				'model_provider="openai"',
				"-c",
				"model_providers.openai.supports_websockets=false",
				"-c",
				"allow_login_shell=false",
				...codexToolkitArguments(
					ctx.workspacePath,
					ctx.frontmatter?.toolkitVersion
						? resolveToolkitBundle(ctx.frontmatter.toolkitVersion)
						: undefined,
					ctx.homePath,
				),
				"--model",
				ctx.frontmatter?.model ?? CODEX_DEFAULT_MODEL,
				"-",
			],
			env: {
				...(home ? { CODEX_HOME: join(home, ".codex") } : {}),
				CODEX_API_KEY: "",
				OPENAI_API_KEY: "",
			},
			stdin: [
				FACTORY_SKILL_POLICY,
				TOOLKIT_POLICY,
				ctx.prompt,
				...ctx.pendingMessages.map((message) => `[STEERING] (${message.priority}) ${message.body}`),
			].join("\n\n"),
		};
	},
};
