import type { ConsoleStats } from "./use-console-stats.ts";

/**
 * Pure label/format logic behind the console topbar figures, split out
 * so the repo-root `bun test` (which resolves no `@/` alias) can test
 * it without importing the component module.
 */

/** Topbar health label, identical at every width (warren-d6ea). */
export function healthLabel(health: ConsoleStats["health"]): "HEALTHY" | "UNREACHABLE" | "—" {
	return health === "ok" ? "HEALTHY" : health === "down" ? "UNREACHABLE" : "—";
}

/** RUNTIME stat value off `GET /instance`; null renders the placeholder. */
export function runtimeValue(runtime: ConsoleStats["runtime"]): string | null {
	return runtime === null ? null : runtime.toUpperCase();
}
