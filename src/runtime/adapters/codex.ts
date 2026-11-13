import { join } from "node:path";
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
	async prepareHome(homePath) {
		await materializeCodexSkillPack(homePath);
		return prepareCodexCredentials(homePath);
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
				// Warren's outer sandbox is the security boundary for unattended work.
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
				ctx.prompt,
				...ctx.pendingMessages.map((message) => `[STEERING] (${message.priority}) ${message.body}`),
			].join("\n\n"),
		};
	},
};
