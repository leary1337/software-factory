/**
 * Runtime-provider registry + the `WARREN_RUNTIME` selector.
 *
 * One place resolves which `RuntimeProvider` (contract in `./contract.ts`) a
 * warren process runs against, exactly once at boot. The default is the
 * in-process `LocalProvider`; the `k8s` backend (`K8sProvider`, pl-829f phase
 * K8S) is opt-in behind `WARREN_RUNTIME=k8s`.
 *
 * Selection rules (design doc §5 registry/selector semantics):
 *   - `WARREN_RUNTIME` unset (or blank) → `local` (the default backend).
 *   - `local` → in-process `LocalProvider` (warren-413d; the burrow-backed
 *     legacy mode was deleted in warren-ea0a).
 *   - `k8s`   → `K8sProvider`.
 *   - `docker` → `DockerProvider` (warren-3732, sibling containers).
 *   - anything else → `UnknownRuntimeError` (fail loud — never silently fall
 *     back to the default, so a typo can't route runs onto the wrong backend).
 *
 * Composition point: `src/server/main/index.ts` (`bootServer`) resolves the
 * local backend via `src/runtime/local/boot-backend.ts`, which builds the
 * in-process engine directly (warren-413d).
 */

import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import type { EnvLike } from "../runs/spawn/callback-env.ts";
import type { RuntimeProvider } from "./contract.ts";
import { DockerProvider, type DockerProviderDeps } from "./docker/provider.ts";
import type { DockerSpawnDeps } from "./docker/spawn.ts";
import { UnknownRuntimeError } from "./errors.ts";
import type { SidecarCascade } from "./local/engine.ts";
import { LocalProvider } from "./local/provider.ts";
import type { LocalRunStore } from "./local/run-store.ts";

/** Runtime backends the selector understands. */
export type RuntimeKind = "local" | "docker";

/** Selector default when `WARREN_RUNTIME` is unset — the self-host backend. */
export const DEFAULT_RUNTIME_KIND: RuntimeKind = "local";

/** Every recognized `WARREN_RUNTIME` value (used for validation + error hints). */
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["local", "docker"];

/** Minimal env surface the selector reads. */
export type RuntimeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies every provider the registry can build is threaded. Kept as a
 * single bag so adding the `k8s` backend later doesn't change the selector's
 * signature. The client is a factory so the registry needn't own a live client
 * (see `LocalProviderDeps`).
 */
export interface RuntimeProviderDeps {
	/**
	 * Server-process env a provider reads to compute its own plumbing (the
	 * LocalProvider's loopback callback URL, §6.3). Optional — providers
	 * default to `process.env`. Kept on the shared bag so the selector's
	 * signature is stable as backends are added.
	 */
	readonly serverEnv?: EnvLike;
	/**
	 * Disk/shell seam the `LocalProvider.finalize()` runs the reap
	 * merge functions over (`ReapFs` / `ReapExec`, `src/runs/reap/types.ts`) —
	 * only consulted for `WARREN_RUNTIME=local`; the `K8sProvider` ignores them.
	 * Optional so callers (and tests) that accept the real `defaultFs` /
	 * `defaultExec` needn't supply them. Kept on the shared bag so the reap
	 * pipeline can route its fallback provider through `resolveRuntimeProvider`
	 * (warren-aa4a) instead of constructing a `LocalProvider` inline.
	 */
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
	/**
	 * OPTIONAL shared run store for the in-process LocalProvider engine
	 * (warren-413d) — only consulted for `WARREN_RUNTIME=local`. Boot
	 * threads the store it also hands the preview sidecar registry
	 * (warren-4bf3), so sidecars resolve profiles off the same records the
	 * engine writes. Absent ⇒ the provider's private default (tests).
	 */
	readonly localStore?: LocalRunStore;
	/**
	 * OPTIONAL preview sidecar cascade for the in-process LocalProvider
	 * (warren-4bf3) — only consulted for `WARREN_RUNTIME=local`. Boot
	 * threads the warren-owned registry so `terminate` releases sidecars +
	 * port forwards. Absent ⇒ terminate skips the cascade (tests).
	 */
	readonly localSidecars?: SidecarCascade;
	/**
	 * Workspace-ready signal (warren-7116) — the runtime → domain edge for the
	 * `runs.workspace_ready_at` stamp. The drive loop fires it after the
	 * workspace is prepared; the boot wiring lands the write through the runs
	 * repo. Only consulted for `WARREN_RUNTIME=local`.
	 */
	readonly onWorkspaceReady?: (runId: string, at: Date) => void;
	/**
	 * OPTIONAL docker spawn seams — only consulted for `WARREN_RUNTIME=docker`
	 * (warren-3732). A test injects a scripted docker CLI here; production
	 * leaves it unset so the seam spawns the real CLI.
	 */
	readonly docker?: DockerSpawnDeps;
}

/**
 * Parse + validate the `WARREN_RUNTIME` selector. Blank/unset resolves to the
 * default; an unrecognized value throws `UnknownRuntimeError`.
 */
export function resolveRuntimeKind(env: RuntimeEnv = process.env): RuntimeKind {
	const raw = env.WARREN_RUNTIME?.trim();
	if (raw === undefined || raw === "") {
		return DEFAULT_RUNTIME_KIND;
	}
	if ((RUNTIME_KINDS as readonly string[]).includes(raw)) {
		return raw as RuntimeKind;
	}
	throw new UnknownRuntimeError(`Unknown WARREN_RUNTIME "${raw}"`, {
		recoveryHint: `Set WARREN_RUNTIME to one of: ${RUNTIME_KINDS.join(", ")} (or leave it unset for "${DEFAULT_RUNTIME_KIND}").`,
	});
}

/**
 * Resolve the runtime provider for this process — call ONCE at boot. Selects on
 * `WARREN_RUNTIME` (see module doc) and constructs the chosen backend from
 * `deps`.
 */
export function resolveRuntimeProvider(
	deps: RuntimeProviderDeps,
	env: RuntimeEnv = process.env,
): RuntimeProvider {
	const kind = resolveRuntimeKind(env);
	switch (kind) {
		case "local":
			// warren-413d + warren-ea0a: the local backend is the in-process
			// engine, full stop — there is no client to wire.
			return new LocalProvider({
				...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
				...(deps.fs !== undefined ? { fs: deps.fs } : {}),
				...(deps.exec !== undefined ? { exec: deps.exec } : {}),
				...(deps.localStore !== undefined ? { store: deps.localStore } : {}),
				...(deps.localSidecars !== undefined ? { sidecars: deps.localSidecars } : {}),
				// warren-7116: thread the workspace-ready signal through the drive
				// deps so the drive loop never touches the database directly.
				...(deps.onWorkspaceReady !== undefined
					? { drive: { onWorkspaceReady: deps.onWorkspaceReady } }
					: {}),
			});
		case "docker":
			return buildDockerProvider(deps);
	}
}

/**
 * Construct the `DockerProvider` (warren-3732) from the shared deps bag.
 * The sibling-container backend reuses the local state roots, run store,
 * and reap seams; only the spawn boundary differs.
 */
function buildDockerProvider(deps: RuntimeProviderDeps): DockerProvider {
	const providerDeps: DockerProviderDeps = {
		...(deps.serverEnv !== undefined ? { serverEnv: deps.serverEnv } : {}),
		...(deps.fs !== undefined ? { fs: deps.fs } : {}),
		...(deps.exec !== undefined ? { exec: deps.exec } : {}),
		...(deps.localStore !== undefined ? { store: deps.localStore } : {}),
		...(deps.localSidecars !== undefined ? { sidecars: deps.localSidecars } : {}),
		...(deps.docker !== undefined ? { docker: deps.docker } : {}),
	};
	return new DockerProvider(providerDeps);
}
