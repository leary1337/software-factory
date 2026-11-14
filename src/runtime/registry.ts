/** Resolve the local runtime; historical backend IDs remain in the wire contract. */
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import type { EnvLike } from "../runs/spawn/callback-env.ts";
import type { RuntimeProvider } from "./contract.ts";
import { UnknownRuntimeError } from "./errors.ts";
import type { DriveDeps } from "./local/drive.ts";
import type { SidecarCascade } from "./local/engine.ts";
import { LocalProvider } from "./local/provider.ts";
import type { LocalRunStore } from "./local/run-store.ts";

/** Runtime backends the selector understands. */
export type RuntimeKind = "local" | "docker";

/** Selector default when `WARREN_RUNTIME` is unset — the self-host backend. */
export const DEFAULT_RUNTIME_KIND: RuntimeKind = "local";

/** Every recognized `WARREN_RUNTIME` value (used for validation + error hints). */
export const RUNTIME_KINDS: readonly RuntimeKind[] = ["local"];

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
	readonly reserveEnvironmentRepair?: DriveDeps["reserveEnvironmentRepair"];
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
	if (raw === "docker")
		throw new UnknownRuntimeError("Docker task execution has been retired", {
			recoveryHint:
				"Use WARREN_RUNTIME=local; project application deployments may still use Docker.",
		});
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
	resolveRuntimeKind(env);
	return new LocalProvider({
		serverEnv: deps.serverEnv ?? env,
		...(deps.fs !== undefined ? { fs: deps.fs } : {}),
		...(deps.exec !== undefined ? { exec: deps.exec } : {}),
		...(deps.localStore !== undefined ? { store: deps.localStore } : {}),
		...(deps.localSidecars !== undefined ? { sidecars: deps.localSidecars } : {}),
		drive: {
			...(deps.onWorkspaceReady ? { onWorkspaceReady: deps.onWorkspaceReady } : {}),
			...(deps.reserveEnvironmentRepair
				? { reserveEnvironmentRepair: deps.reserveEnvironmentRepair }
				: {}),
		},
	});
}
