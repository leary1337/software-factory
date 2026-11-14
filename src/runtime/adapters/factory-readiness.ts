import { existsSync } from "node:fs";
import { codexAuthFile } from "./codex-credentials.ts";

/** Adapter-owned executable and authorization prerequisites for the local factory. */
export async function assertFactoryRuntimeReady(): Promise<void> {
	if (process.platform !== "darwin") throw new Error("The current factory requires macOS");
	if (!Bun.which(process.env.WARREN_CODEX_BIN ?? "codex"))
		throw new Error("Codex executable is unavailable");
	if (!existsSync(codexAuthFile())) throw new Error("Codex authorization is missing");
}
