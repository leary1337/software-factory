/** Start the local macOS factory, configure credentials and open the authenticated interface. */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Command } from "commander";
import type { EnvLike } from "../../client/config.ts";
import { saveWarrenClientConfigToFile } from "../../client/config-file.ts";
import type { WarrenClientConfig } from "../../client/index.ts";
import type { CliContext } from "../output.ts";
import { commandFailure } from "../output.ts";
import { runServe, type ServeDeps } from "./serve.ts";
import { defaultUpWizardDeps, mergeUnderEnv, runUpWizard, type UpWizardDeps } from "./up-wizard.ts";

export interface UpArgs {
	/** `--no-open` — do not open the browser at the setup URL (warren-48f8). */
	readonly open?: boolean;
	/**
	 * `--no-wizard` — skip the credential wizard (warren-80e9). Also
	 * automatic when stdin is not a TTY (CI, scripts): prompts never
	 * block, the stored `~/.warren/env` still loads under the real env.
	 */
	readonly wizard?: boolean;
}

/** Host platform for local runtime support. */
export interface UpRuntimeProbe {
	readonly platform: NodeJS.Platform;
}

export interface UpDeps {
	/** Runtime detection seams; defaults probe the live machine. */
	readonly probe?: UpRuntimeProbe;
	/** Injected for tests; production delegates to the real serve path. */
	readonly serveDeps?: ServeDeps;
	/** Client-config persistence (the `warren login` function). */
	readonly saveConfig?: (config: WarrenClientConfig, env: EnvLike) => string;
	/** Data-dir creation (tests script failure). */
	readonly mkdir?: (path: string) => void;
	readonly homeDir?: () => string;
	/** warren-48f8: is stdout a TTY? Defaults to the live process check. */
	readonly isTty?: () => boolean;
	/** warren-48f8: open `url` in the platform browser (tests record the call). */
	readonly openBrowser?: (url: string) => void;
	/** Credential wizard seams; defaults probe the live machine (warren-80e9). */
	readonly wizard?: UpWizardDeps;
	/** The server process env the stored credentials export into; defaults to `process.env`. */
	readonly processEnv?: Record<string, string | undefined>;
}

export interface UpResult {
	readonly exitCode: number;
	readonly url?: string;
}

/** What runtime detection decided. */
export type UpRuntimeDecision =
	| { readonly choice: "boot"; readonly runtime?: string; readonly sentence: string }
	| { readonly choice: "fail"; readonly message: string };

/** Boot only the supported local host; do not suggest retired sandbox/container runtimes. */
export function detectUpRuntime(env: EnvLike, probe: UpRuntimeProbe): UpRuntimeDecision {
	const explicit = env.WARREN_RUNTIME?.trim();
	if (explicit && explicit !== "local")
		return { choice: "fail", message: `Runtime '${explicit}' is retired; use local` };
	if (probe.platform !== "darwin")
		return {
			choice: "fail",
			message: "Local execution currently requires macOS; Linux deployment is deferred",
		};
	return { choice: "boot", runtime: "local", sentence: "runtime: local (macOS host process)" };
}

/** Default WARREN_DATA_DIR for `warren up` when the env leaves it unset. */
export function defaultUpDataDir(home: string): string {
	return join(home, ".warren", "data");
}

/** Whether an executable name resolves on the configured PATH. */
export function binaryOnPath(name: string, env: EnvLike = process.env): boolean {
	return (env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, name)));
}

/** Which command opens a URL on this platform (best-effort). */
function browserOpener(context: CliContext): (url: string) => void {
	return (url: string) => {
		const cmd = process.platform === "darwin" ? "open" : "xdg-open";
		// Fire-and-forget: a failed/absent opener must never take the server
		// down — the printed URL is the fallback path.
		void context.spawn([cmd, url], { cwd: process.cwd() }).catch(() => undefined);
	};
}

/**
 * gh #1298: dispatch-time seams (e.g. the agent git identity in
 * `src/runs/spawn/git-identity.ts`) read `process.env`, not the boot env.
 * Export the merged value of every stored key so `~/.warren/env` acts like
 * exported env (the real env still wins, via `merged`).
 */
function exportStoredEnv(
	target: Record<string, string | undefined>,
	stored: Record<string, string>,
	merged: Record<string, string | undefined>,
): void {
	for (const key of Object.keys(stored)) {
		const value = merged[key];
		if (value !== undefined) target[key] = value;
	}
}

export async function runUp(context: CliContext, deps: UpDeps, args: UpArgs): Promise<UpResult> {
	const probe: UpRuntimeProbe = deps.probe ?? {
		platform: process.platform,
	};

	const decision = detectUpRuntime(context.env, probe);
	if (decision.choice === "fail") {
		context.stdio.stderr.write(`warren up: ${decision.message}\n`);
		return { exitCode: 1 };
	}

	// Data dir: default ~/.warren/data (created 0700) only when unset.
	const env = { ...context.env } as Record<string, string | undefined>;
	if (env.WARREN_DATA_DIR === undefined || env.WARREN_DATA_DIR.trim() === "") {
		const dataDir = defaultUpDataDir((deps.homeDir ?? homedir)());
		try {
			(deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 })))(dataDir);
		} catch (err) {
			return commandFailure(context, err);
		}
		env.WARREN_DATA_DIR = dataDir;
	}
	if (decision.runtime !== undefined) {
		env.WARREN_RUNTIME = decision.runtime;
	}

	const upContext: CliContext = { ...context, env };
	const save =
		deps.saveConfig ??
		((config: WarrenClientConfig, e: EnvLike) => saveWarrenClientConfigToFile(config, e));

	context.stdio.stdout.write(`${decision.sentence}\n`);

	// Credential wizard (warren-80e9): env > stored > prompted. The stored
	// ~/.warren/env loads on every boot; prompts run only when interactive
	// and a needed credential is absent from both env and store.
	const wizardDeps =
		deps.wizard ?? defaultUpWizardDeps(context, context.env, deps.homeDir ?? homedir);
	const storedEnv = await runUpWizard(context, wizardDeps, { wizard: args.wizard !== false });
	const merged = mergeUnderEnv(env, storedEnv);
	Object.assign(env, merged);
	exportStoredEnv(deps.processEnv ?? process.env, storedEnv, merged);

	return runServe(
		upContext,
		{
			...deps.serveDeps,
			// warren-c18a: persist the boot's operator token as the client
			// login, exactly as `warren login` would — no log-grep.
			onBooted: async (handle) => {
				if (handle.operatorToken === undefined) return;
				const path = save({ baseUrl: handle.url, token: handle.operatorToken }, env);
				context.stdio.stdout.write(
					`✔ logged in to ${handle.url} (config: ${path}) — warren commands work with no env vars now\n`,
				);
				// warren-48f8: open the one-time setup URL in a browser so the
				// operator's tab lands already-logged-in; always print it as the
				// fallback (a non-TTY stdout or a failed opener still shows it).
				if (handle.setupUrl === undefined) {
					context.stdio.stdout.write(`UI: ${handle.url}\n`);
					return;
				}
				if (args.open === false) {
					context.stdio.stdout.write(`UI (open this to sign in): ${handle.setupUrl}\n`);
					return;
				}
				context.stdio.stdout.write(`UI: ${handle.setupUrl}\n`);
				if ((deps.isTty ?? (() => process.stdout.isTTY ?? false))()) {
					(deps.openBrowser ?? browserOpener(context))(handle.setupUrl);
				}
			},
		},
		{ setupHandoff: true },
	);
}

export function registerUpCommand(program: Command, context: CliContext): void {
	program
		.command("up")
		.description(
			"boot warren for a fresh machine: detect the runtime, default the data dir, serve, and log the operator in",
		)
		.option("--no-open", "do not open the UI in a browser (the setup URL is still printed)")
		.option(
			"--no-wizard",
			"skip the first-boot credential wizard (also automatic when stdin is not a TTY)",
		)
		.action(async (opts: { open?: boolean; wizard?: boolean }) => {
			const result = await runUp(context, {}, { open: opts.open, wizard: opts.wizard });
			process.exit(result.exitCode);
		});
}
