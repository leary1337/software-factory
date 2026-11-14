import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	claudeToolkitConfig,
	TOOLKIT_VERSION,
	type ToolkitBundle,
	toolkitServers,
} from "./catalog.ts";

const START = "# BEGIN factory managed MCP";
const END = "# END factory managed MCP";
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
interface Receipt {
	codex: string;
	claude: Record<string, string>;
	version: string;
}

async function existing(path: string): Promise<string> {
	try {
		if ((await lstat(path)).isSymbolicLink())
			throw new Error(`Refusing a symlink configuration: ${path}`);
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

function codexBlock(bundle?: ToolkitBundle, home?: string): string {
	const lines = [START];
	for (const [name, server] of Object.entries(toolkitServers(undefined, bundle, home))) {
		lines.push(`[mcp_servers.${name}]`);
		for (const [key, value] of Object.entries({
			url: server.url,
			command: server.command,
			args: server.args,
			enabled_tools: server.enabledTools,
			startup_timeout_sec: 60,
		})) {
			if (value !== undefined) lines.push(`${key} = ${JSON.stringify(value)}`);
		}
		if (server.env) {
			lines.push(`[mcp_servers.${name}.env]`);
			for (const [key, value] of Object.entries(server.env))
				lines.push(`${key} = ${JSON.stringify(value)}`);
		}
	}
	lines.push(END);
	return lines.join("\n");
}

function prepareCodex(current: string, previous: Receipt | undefined, block: string): string {
	const begin = current.indexOf(START);
	const end = current.indexOf(END);
	let rest = current;
	if (begin >= 0 && end >= begin) {
		const block = current.slice(begin, end + END.length);
		if (fingerprint(block) !== previous?.codex)
			throw new Error(
				"Factory MCP configuration was edited; preserve or reconcile it before updating",
			);
		rest = current.slice(0, begin) + current.slice(end + END.length);
	} else if (begin >= 0 || end >= 0) throw new Error("Incomplete factory MCP configuration block");
	const parsed = Bun.TOML.parse(rest) as { mcp_servers?: Record<string, unknown> };
	if (Object.keys(toolkitServers()).some((name) => parsed.mcp_servers?.[name] !== undefined))
		throw new Error("A personal MCP configuration already uses a factory server name");
	return `${rest.trimEnd()}\n\n${block}\n`.trimStart();
}

function prepareClaude(
	current: string,
	previous: Receipt | undefined,
	bundle?: ToolkitBundle,
	home?: string,
): { text: string; owned: Record<string, string> } {
	const config = current ? JSON.parse(current) : {};
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("Invalid Claude configuration");
	const servers: Record<string, unknown> = config.mcpServers ?? {};
	if (typeof servers !== "object" || Array.isArray(servers))
		throw new Error("Invalid Claude MCP server collection");
	const desired: Record<string, unknown> = JSON.parse(
		claudeToolkitConfig(undefined, bundle, home),
	).mcpServers;
	const owned: Record<string, string> = {};
	for (const [name, before] of Object.entries(previous?.claude ?? {})) {
		if (
			!(name in desired) &&
			servers[name] !== undefined &&
			fingerprint(JSON.stringify(servers[name])) === before
		)
			delete servers[name];
	}
	for (const [name, value] of Object.entries(desired)) {
		const before = servers[name];
		if (before !== undefined && fingerprint(JSON.stringify(before)) !== previous?.claude[name])
			throw new Error(`Preserve personal MCP server ${name} before updating the factory catalog`);
		servers[name] = value;
		owned[name] = fingerprint(JSON.stringify(value));
	}
	return { text: `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, owned };
}

async function atomicWrite(path: string, body: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.factory-${crypto.randomUUID()}`;
	await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
	await rename(temporary, path);
}

/** Preflight both formats before changing either. Credentials and unrelated keys stay in place. */
export async function installPersonalMcp(
	home: string,
	apply = false,
	bundle?: ToolkitBundle,
	version = TOOLKIT_VERSION,
) {
	const codexPath = join(home, ".codex", "config.toml");
	const claudePath = join(home, ".claude.json");
	const receiptPath = join(home, ".agents", "factory-mcp.json");
	const [codex, claude, receiptText] = await Promise.all([
		existing(codexPath),
		existing(claudePath),
		existing(receiptPath),
	]);
	const previous: Receipt | undefined = receiptText ? JSON.parse(receiptText) : undefined;
	const block = codexBlock(bundle, home);
	const nextCodex = prepareCodex(codex, previous, block);
	const nextClaude = prepareClaude(claude, previous, bundle, home);
	const files = [
		{ path: codexPath, before: codex, after: nextCodex },
		{ path: claudePath, before: claude, after: nextClaude.text },
	].filter((file) => file.before !== file.after);
	if (apply) {
		for (const file of files) await atomicWrite(file.path, file.after);
		const receipt = `${JSON.stringify({ version, codex: fingerprint(block), claude: nextClaude.owned }, null, 2)}\n`;
		if (receiptText !== receipt) await atomicWrite(receiptPath, receipt);
	}
	return { version, applied: apply, writes: files.map((file) => file.path) };
}
