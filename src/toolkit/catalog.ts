import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { browserSocketDirectory } from "./browser-sockets.ts";

const RemoteSchema = z.object({ url: z.string().url(), tools: z.array(z.string()).min(1) });
export const CatalogSchema = z.object({
	schemaVersion: z.literal(1),
	exa: RemoteSchema,
	context7: RemoteSchema,
	graphify: z.object({
		package: z.literal("graphifyy"),
		version: z.string().regex(/^\d+\.\d+\.\d+$/),
		backend: z.literal("none"),
	}),
	playwright: z.object({
		mcpVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
		cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
		browser: z.literal("chrome"),
	}),
});

export type ToolkitCatalog = z.infer<typeof CatalogSchema>;
export interface ToolkitBundle {
	readonly root: string;
	readonly catalog: ToolkitCatalog;
}
export const TOOLKIT_CATALOG_PATH =
	process.env.WARREN_TOOLKIT_CATALOG ??
	resolve(import.meta.dir, "../../factory/toolkit/catalog.json");
export const TOOLKIT = CatalogSchema.parse(JSON.parse(readFileSync(TOOLKIT_CATALOG_PATH, "utf8")));
export const TOOLKIT_VERSION = createHash("sha256").update(JSON.stringify(TOOLKIT)).digest("hex");

export interface McpDefinition {
	readonly url?: string;
	readonly command?: string;
	readonly args?: readonly string[];
	readonly enabledTools?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

/** Every consumer gets anonymous remote tools and pinned local tools from this catalog. */
export function toolkitServers(
	workspacePath?: string,
	bundle?: ToolkitBundle,
	homePath?: string,
): Record<string, McpDefinition> {
	const catalog = bundle?.catalog ?? TOOLKIT;
	return {
		factory_exa: { url: catalog.exa.url, enabledTools: catalog.exa.tools },
		factory_context7: { url: catalog.context7.url, enabledTools: catalog.context7.tools },
		factory_graphify: {
			command: process.execPath,
			args: [
				"--env-file=/dev/null",
				bundle
					? resolve(bundle.root, "graphify-mcp.ts")
					: resolve(import.meta.dir, "graphify-mcp.ts"),
				...(workspacePath ? [workspacePath] : []),
			],
			enabledTools: ["graphify_index", "graphify_query"],
			...(bundle ? { env: { WARREN_TOOLKIT_CATALOG: resolve(bundle.root, "catalog.json") } } : {}),
		},
		factory_playwright: {
			command: "npx",
			env: { PWTEST_SOCKETS_DIR: browserSocketDirectory(homePath) },
			args: [
				"-y",
				`@playwright/mcp@${catalog.playwright.mcpVersion}`,
				"--browser",
				catalog.playwright.browser,
				"--isolated",
				"--headless",
				"--output-dir",
				resolve(homePath ?? homedir(), ".cache/factory/playwright"),
			],
		},
	};
}

export function codexToolkitArguments(
	workspacePath: string,
	bundle?: ToolkitBundle,
	homePath?: string,
): string[] {
	return Object.entries(toolkitServers(workspacePath, bundle, homePath)).flatMap(
		([name, server]) => {
			const values = {
				url: server.url,
				command: server.command,
				args: server.args,
				enabled_tools: server.enabledTools,
				startup_timeout_sec: 60,
			};
			return [
				...Object.entries(values),
				...Object.entries(server.env ?? {}).map(([key, value]) => [`env.${key}`, value]),
			]
				.filter(([, value]) => value !== undefined)
				.flatMap(([key, value]) => ["-c", `mcp_servers.${name}.${key}=${JSON.stringify(value)}`]);
		},
	);
}

export function claudeToolkitConfig(
	workspacePath?: string,
	bundle?: ToolkitBundle,
	homePath?: string,
): string {
	return JSON.stringify({
		mcpServers: Object.fromEntries(
			Object.entries(toolkitServers(workspacePath, bundle, homePath)).map(([name, s]) => [
				name,
				s.url
					? { type: "http", url: s.url }
					: { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) },
			]),
		),
	});
}

export const TOOLKIT_POLICY =
	"Use the shared factory MCP catalog. Exa and Context7 are anonymous free tools; never add payment credentials, upgrade a quota, or switch to a paid service. Graphify is local code-only analysis with every model backend disabled. Confirm graph findings in source files. If an optional tool is unavailable or rate-limited, use adequate alternative evidence. If required evidence is still missing, report a blocker with the unavailable tool and missing evidence; never report an unperformed check as passed. Playwright browsing supplements, but never replaces, the project's reproducible tests.";
