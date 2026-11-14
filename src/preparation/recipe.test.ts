import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreparationRecipeSchema } from "../projects/preparation-schema.ts";
import { resolvePreparation } from "./recipe.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "prep-recipe-"));
	roots.push(root);
	for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
	return root;
}
describe("resolvePreparation", () => {
	test("uses the existing lockfile manager and detects lockfile changes", async () => {
		const root = await fixture({
			"package.json": '{"packageManager":"pnpm@10.1.0"}',
			"pnpm-lock.yaml": "a",
		});
		const first = await resolvePreparation(root);
		expect(first.steps).toEqual([{ tool: "pnpm", args: ["install", "--frozen-lockfile"] }]);
		expect(first.versions.pnpm).toBe("10.1.0");
		await writeFile(join(root, "pnpm-lock.yaml"), "b");
		expect((await resolvePreparation(root)).inputDigest).not.toBe(first.inputDigest);
	});
	test("fails ambiguous or missing locks and supports an explicit command", async () => {
		const root = await fixture({ "package.json": "{}" });
		await expect(resolvePreparation(root)).rejects.toThrow("lockfile");
		expect(
			(await resolvePreparation(root, { recipe: "command", command: "custom prepare" })).steps,
		).toEqual([{ tool: "shell", args: ["-c", "custom prepare"] }]);
		await writeFile(join(root, "go.mod"), "module fixture\ngo 1.24.0");
		await expect(resolvePreparation(root)).rejects.toThrow("Several");
	});
	test("selects uv Python without migrating missing lockfiles", async () => {
		const root = await fixture({
			"pyproject.toml": "[project]",
			"uv.lock": "version=1",
			".python-version": "3.12",
		});
		expect((await resolvePreparation(root)).steps).toEqual([
			{ tool: "uv", args: ["sync", "--frozen", "--python", "3.12"] },
		]);
		await rm(join(root, "uv.lock"));
		await expect(resolvePreparation(root)).rejects.toThrow("not migrated");
	});
	test("pins the Go toolchain and allows a project version override", async () => {
		const root = await fixture({ "go.mod": "module fixture\ngo 1.24\ntoolchain go1.24.2\n" });
		expect((await resolvePreparation(root)).goToolchain).toBe("go1.24.2+auto");
		expect(
			(await resolvePreparation(root, { recipe: "go", tools: { go: { version: "1.25.1" } } }))
				.goToolchain,
		).toBe("go1.25.1+auto");
	});
	test("validates partial tool settings and refuses relative executables", () => {
		expect(
			PreparationRecipeSchema.safeParse({ recipe: "auto", tools: { bun: { version: "1.3" } } })
				.success,
		).toBe(true);
		expect(PreparationRecipeSchema.safeParse({ recipe: "command" }).success).toBe(false);
		expect(
			PreparationRecipeSchema.safeParse({ recipe: "go", tools: { go: { executable: "go" } } })
				.success,
		).toBe(false);
	});
});
