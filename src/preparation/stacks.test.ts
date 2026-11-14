import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreparationRecipe } from "../core/preparation.ts";
import { runHostProcess } from "../runtime/local/process-spawn.ts";
import type { SandboxProfile } from "../sandbox/types.ts";
import { runPreparation } from "./run.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function command(argv: string[], cwd: string) {
	const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	const [code, out, error] = await Promise.all([
		p.exited,
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	if (code) throw new Error(error);
	return out.trim();
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "prep-stacks-"));
	roots.push(root);
	const workspace = join(root, "source");
	await mkdir(workspace);
	return { root, workspace };
}
async function prepare(root: string, source: string, name: string, recipe: PreparationRecipe) {
	const workspace = join(root, name);
	const home = join(root, "homes", name);
	await cp(source, workspace, { recursive: true });
	await mkdir(home, { recursive: true });
	const profile: SandboxProfile = {
		workspace,
		home,
		network: "open",
		allowedDomains: [],
		readOnlyMounts: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: ["/opt/homebrew/bin", dirname(process.execPath)],
	};
	return runPreparation({
		profile,
		config: recipe,
		stage: name === "gate" ? "verification" : "agent",
		runHome: home,
		owner: { cancelRequested: false },
		spawn: runHostProcess,
		emit: () => {},
	});
}
describe.skipIf(process.platform !== "darwin")("language preparation", () => {
	test.skipIf(!Bun.which("uv"))(
		"creates distinct uv environments and uses changed dependency locks",
		async () => {
			const { root, workspace } = await fixture();
			const uv = Bun.which("uv") ?? "uv";
			const python = await command([uv, "python", "find"], workspace);
			await mkdir(join(workspace, "dep"));
			await writeFile(
				join(workspace, "dep/pyproject.toml"),
				'[project]\nname="local-dep"\nversion="1.0.0"\n',
			);
			const manifest =
				'[project]\nname="fixture"\nversion="1.0.0"\nrequires-python=">=3.12"\ndependencies=["local-dep"]\n[tool.uv.sources]\nlocal-dep={path="dep"}\n';
			await writeFile(join(workspace, "pyproject.toml"), manifest);
			await command([uv, "lock", "--offline", "--python", python], workspace);
			const recipe: PreparationRecipe = {
				recipe: "python-uv",
				tools: { uv: { executable: uv }, python: { executable: python } },
				timeoutMs: 30000,
			};
			const agent = await prepare(root, workspace, "agent", recipe);
			const gate = await prepare(root, workspace, "gate", recipe);
			expect(agent.setEnv.VIRTUAL_ENV).not.toBe(gate.setEnv.VIRTUAL_ENV);
			expect(
				await command(
					[
						join(agent.workspace, ".venv/bin/python"),
						"-c",
						"import importlib.metadata; print(importlib.metadata.version('local-dep'))",
					],
					agent.workspace,
				),
			).toBe("1.0.0");
			await writeFile(
				join(workspace, "dep/pyproject.toml"),
				'[project]\nname="local-dep"\nversion="2.0.0"\n',
			);
			await command([uv, "lock", "--offline", "--python", python], workspace);
			const updated = await prepare(root, workspace, "updated", recipe);
			expect(
				await command(
					[
						join(updated.workspace, ".venv/bin/python"),
						"-c",
						"import importlib.metadata; print(importlib.metadata.version('local-dep'))",
					],
					updated.workspace,
				),
			).toBe("2.0.0");
			expect(
				await command(
					[
						join(gate.workspace, ".venv/bin/python"),
						"-c",
						"import importlib.metadata; print(importlib.metadata.version('local-dep'))",
					],
					gate.workspace,
				),
			).toBe("1.0.0");
			await rm(join(workspace, "dep"), { recursive: true });
			await expect(prepare(root, workspace, "failed", recipe)).rejects.toThrow(
				"Environment preparation failed",
			);
		},
		60000,
	);
	test.skipIf(!Bun.which("go"))(
		"prepares Go copies with a pinned toolchain and shared immutable module cache",
		async () => {
			const { root, workspace } = await fixture();
			const go = Bun.which("go") ?? "go";
			const version = (await command([go, "version"], workspace)).match(/go(\d+\.\d+\.\d+)/)?.[1];
			if (!version) throw new Error("Go version missing");
			await mkdir(join(workspace, "dep"));
			await writeFile(join(workspace, "dep/go.mod"), `module example.test/dep\ngo ${version}\n`);
			await writeFile(join(workspace, "dep/value.go"), 'package dep\nconst Value="one"\n');
			await writeFile(
				join(workspace, "go.mod"),
				`module example.test/fixture\ngo ${version}\nrequire example.test/dep v0.0.0\nreplace example.test/dep => ./dep\n`,
			);
			await writeFile(
				join(workspace, "main.go"),
				'package main\nimport("fmt";"example.test/dep")\nfunc main(){fmt.Print(dep.Value)}\n',
			);
			const recipe: PreparationRecipe = {
				recipe: "go",
				tools: { go: { executable: go, version } },
				timeoutMs: 30000,
			};
			const agent = await prepare(root, workspace, "agent", recipe);
			const gate = await prepare(root, workspace, "gate", recipe);
			expect(agent.setEnv.GOTOOLCHAIN).toBe(`go${version}+auto`);
			expect(agent.setEnv.GOMODCACHE).toBe(gate.setEnv.GOMODCACHE);
			expect(await command([go, "run", "."], agent.workspace)).toBe("one");
			await writeFile(join(workspace, "dep/value.go"), 'package dep\nconst Value="two"\n');
			const updated = await prepare(root, workspace, "updated", recipe);
			expect(await command([go, "run", "."], updated.workspace)).toBe("two");
			expect(await readFile(join(gate.workspace, "dep/value.go"), "utf8")).toContain('"one"');
			await expect(
				prepare(root, workspace, "missing", {
					recipe: "go",
					tools: { go: { executable: "/missing/go" } },
				}),
			).rejects.toThrow("not executable");
		},
		60000,
	);
});
