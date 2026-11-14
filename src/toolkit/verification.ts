import { existsSync } from "node:fs";
import type { ToolkitDependencyCheck } from "../core/wire.ts";
import { TOOLKIT, type ToolkitCatalog } from "./catalog.ts";

/** Check the installed local prerequisites; optional remote quotas never trigger a paid fallback. */
export function verifyToolkitDependencies(
	catalog: ToolkitCatalog = TOOLKIT,
): ToolkitDependencyCheck[] {
	const isFreeCatalog =
		catalog.exa.url === "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa" &&
		catalog.exa.tools.join(",") === "web_search_exa,web_fetch_exa" &&
		catalog.context7.url === "https://mcp.context7.com/mcp" &&
		catalog.context7.tools.join(",") === "resolve-library-id,query-docs" &&
		catalog.graphify.backend === "none";
	return [
		{ name: "Free catalog", available: isFreeCatalog },
		{ name: "Bun", available: !!Bun.which("bun") },
		{ name: "Node/npx", available: !!Bun.which("npx") },
		{ name: "Python/uvx", available: !!Bun.which("uvx") },
		{
			name: "Local Chrome",
			available:
				process.platform === "darwin"
					? existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
					: !!(Bun.which("google-chrome") || Bun.which("chromium")),
		},
	];
}

export function assertToolkitDependencies(catalog: ToolkitCatalog): void {
	const missing = verifyToolkitDependencies(catalog).filter((check) => !check.available);
	if (missing.length)
		throw new Error(
			`Toolkit prerequisites unavailable: ${missing.map((check) => check.name).join(", ")}`,
		);
}
