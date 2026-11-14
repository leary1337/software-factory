import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PreparationRecipe } from "../core/preparation.ts";
import type { PreparationToolName } from "../core/wire.ts";
import type { SandboxProfile } from "../sandbox/types.ts";
import type { PreparationPlan } from "./recipe.ts";

export interface PreparedEnvironment {
	profile: SandboxProfile;
	executables: Partial<Record<PreparationToolName | "shell", string>>;
}

/** Pin absolute executables once; share only download/build caches, never installed environments. */
export async function preparationEnvironment(
	profile: SandboxProfile,
	plan: PreparationPlan,
	config: PreparationRecipe | undefined,
	cacheRoot: string,
): Promise<PreparedEnvironment> {
	const names = new Set(plan.steps.map((step) => step.tool));
	for (const name of Object.keys(config?.tools ?? {})) {
		if (name !== "python" || config?.tools?.python?.executable)
			names.add(name as PreparationToolName);
	}
	if (plan.steps.some((step) => ["npm", "pnpm", "yarn"].includes(step.tool))) names.add("node");
	const executables: PreparedEnvironment["executables"] = {};
	for (const name of names) {
		const path =
			name === "shell" ? "/bin/sh" : (config?.tools?.[name]?.executable ?? Bun.which(name));
		if (!path)
			throw new Error(
				`Preparation tool '${name}' is unavailable; configure its executable in project settings`,
			);
		await access(path, constants.X_OK).catch(() => {
			throw new Error(`Preparation tool '${name}' is not executable: ${path}`);
		});
		executables[name] = path;
	}
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
	const dirs = [
		...new Set([
			...Object.values(executables).map((path) => dirname(path)),
			...profile.toolchainPaths,
			"/usr/bin",
			"/bin",
		]),
	];
	const env: Record<string, string> = {
		...profile.setEnv,
		PATH: dirs.join(":"),
		BUN_INSTALL_CACHE_DIR: join(cacheRoot, "bun"),
		npm_config_cache: join(cacheRoot, "npm"),
		npm_config_store_dir: join(cacheRoot, "pnpm"),
		YARN_CACHE_FOLDER: join(cacheRoot, "yarn"),
		UV_CACHE_DIR: join(cacheRoot, "uv"),
		GOMODCACHE: join(cacheRoot, "go-mod"),
		GOCACHE: join(cacheRoot, "go-build"),
	};
	if (plan.recipe === "python-uv") {
		env.VIRTUAL_ENV = join(profile.workspace, ".venv");
		env.UV_PROJECT_ENVIRONMENT = env.VIRTUAL_ENV;
		env.PATH = `${join(env.VIRTUAL_ENV, "bin")}:${env.PATH}`;
	}
	if (plan.goToolchain) env.GOTOOLCHAIN = plan.goToolchain;
	return { profile: { ...profile, setEnv: env }, executables };
}
