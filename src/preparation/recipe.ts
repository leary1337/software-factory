import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparationRecipe } from "../core/preparation.ts";
import type { PreparationRecipeKind, PreparationToolName } from "../core/wire.ts";

export interface PreparationStep {
	tool: PreparationToolName | "shell";
	args: string[];
}
export interface PreparationPlan {
	recipe: PreparationRecipeKind;
	steps: PreparationStep[];
	versions: Partial<Record<PreparationToolName, string>>;
	inputDigest: string;
	python?: string;
	goToolchain?: string;
}

const INPUTS = [
	"package.json",
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"pyproject.toml",
	"uv.lock",
	".python-version",
	"go.mod",
	"go.sum",
];

async function inputsAt(workspace: string): Promise<Map<string, Buffer>> {
	const inputs = new Map<string, Buffer>();
	for (const name of INPUTS) {
		try {
			inputs.set(name, await readFile(join(workspace, name)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return inputs;
}

function detectRecipe(inputs: Map<string, Buffer>): PreparationRecipeKind {
	const choices: PreparationRecipeKind[] = [];
	if (inputs.has("package.json")) choices.push("javascript");
	if (inputs.has("pyproject.toml")) choices.push("python-uv");
	if (inputs.has("go.mod")) choices.push("go");
	if (choices.length > 1)
		throw new Error("Several project stacks detected; choose a preparation recipe or command");
	return choices[0] ?? "auto";
}

const JS_LOCKS: ReadonlyArray<[PreparationToolName, string]> = [
	["bun", "bun.lock"],
	["bun", "bun.lockb"],
	["npm", "package-lock.json"],
	["npm", "npm-shrinkwrap.json"],
	["pnpm", "pnpm-lock.yaml"],
	["yarn", "yarn.lock"],
];

function javascript(inputs: Map<string, Buffer>, plan: PreparationPlan): void {
	const manifest = JSON.parse(inputs.get("package.json")?.toString() ?? "{}") as {
		packageManager?: unknown;
	};
	const pinned =
		typeof manifest.packageManager === "string"
			? /^(bun|npm|pnpm|yarn)@([^+]+)(?:\+.*)?$/.exec(manifest.packageManager)
			: null;
	const managers = new Set(
		JS_LOCKS.filter(([, lock]) => inputs.has(lock)).map(([manager]) => manager),
	);
	const manager = pinned?.[1] as PreparationToolName | undefined;
	if (managers.size !== 1 || (manager && !managers.has(manager)))
		throw new Error("JavaScript preparation requires one matching package manager lockfile");
	const selected = manager ?? [...managers][0];
	if (!selected) throw new Error("No JavaScript package manager lockfile found");
	if (pinned?.[2]) plan.versions[selected] ??= pinned[2];
	const args =
		selected === "npm"
			? ["ci", "--no-audit", "--no-fund"]
			: selected === "yarn"
				? [
						"install",
						plan.versions.yarn?.startsWith("1.") ||
						inputs.get("yarn.lock")?.toString().includes("# yarn lockfile v1")
							? "--frozen-lockfile"
							: "--immutable",
					]
				: ["install", "--frozen-lockfile"];
	plan.steps.push({ tool: selected, args });
}

function pythonUv(
	inputs: Map<string, Buffer>,
	plan: PreparationPlan,
	config: PreparationRecipe,
): void {
	if (!inputs.has("pyproject.toml") || !inputs.has("uv.lock"))
		throw new Error(
			"Python preparation requires pyproject.toml and uv.lock; the project is not migrated automatically",
		);
	plan.python =
		config.tools?.python?.executable ??
		config.tools?.python?.version ??
		inputs.get(".python-version")?.toString().trim();
	delete plan.versions.python;
	plan.steps.push({
		tool: "uv",
		args: ["sync", "--frozen", ...(plan.python ? ["--python", plan.python] : [])],
	});
}

function golang(inputs: Map<string, Buffer>, plan: PreparationPlan): void {
	const mod = inputs.get("go.mod")?.toString();
	if (!mod) throw new Error("Go preparation requires go.mod");
	const selected =
		plan.versions.go ?? /^toolchain go(\S+)/m.exec(mod)?.[1] ?? /^go (\S+)/m.exec(mod)?.[1];
	if (!selected) throw new Error("Go preparation requires a version in go.mod or project settings");
	const version = /^\d+\.\d+$/.test(selected) ? `${selected}.0` : selected;
	if (!/^\d+\.\d+\.\d+(?:rc\d+|beta\d+)?$/.test(version))
		throw new Error("Invalid Go toolchain version");
	plan.goToolchain = `go${version}+auto`;
	delete plan.versions.go;
	plan.steps.push(
		{ tool: "go", args: ["mod", "download"] },
		{ tool: "go", args: ["mod", "verify"] },
	);
}

/** Resolve from this checkout every time; a cache never substitutes for its lockfile. */
export async function resolvePreparation(
	workspace: string,
	config: PreparationRecipe = { recipe: "auto" },
): Promise<PreparationPlan> {
	const inputs = await inputsAt(workspace);
	const digest = createHash("sha256");
	for (const [name, body] of inputs) digest.update(name).update("\0").update(body);
	digest.update(JSON.stringify(config));
	const versions: PreparationPlan["versions"] = {};
	for (const [name, tool] of Object.entries(config.tools ?? {}))
		if (tool?.version) versions[name as PreparationToolName] = tool.version;
	const recipe = config.command
		? "command"
		: config.recipe === "auto"
			? detectRecipe(inputs)
			: config.recipe;
	const plan: PreparationPlan = { recipe, steps: [], versions, inputDigest: digest.digest("hex") };
	if (recipe === "command") {
		if (!config.command) throw new Error("Preparation command is missing");
		plan.steps.push({ tool: "shell", args: ["-c", config.command] });
	} else if (recipe === "javascript") javascript(inputs, plan);
	else if (recipe === "python-uv") pythonUv(inputs, plan, config);
	else if (recipe === "go") golang(inputs, plan);
	return plan;
}
