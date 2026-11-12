import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectInputs } from "./project-inputs.ts";

test("resolves only the named project's real host directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "project-inputs-"));
	try {
		await mkdir(join(root, "prj_a"));
		await writeFile(join(root, "prj_a", "snapshot"), "data");
		expect(await resolveProjectInputs("prj_a", root)).toBe(await realpath(join(root, "prj_a")));
		expect(await resolveProjectInputs("prj_b", root)).toBeUndefined();
		expect(await resolveProjectInputs(undefined, root)).toBeUndefined();
		await expect(resolveProjectInputs("../prj_a", root)).rejects.toThrow("Invalid");
		await expect(resolveProjectInputs("prj_a", "relative")).rejects.toThrow("Invalid");
		await symlink(join(root, "prj_a"), join(root, "prj_b"));
		await expect(resolveProjectInputs("prj_b", root)).rejects.toThrow("real directory");
		await symlink("/etc/hosts", join(root, "prj_a", "escape"));
		await expect(resolveProjectInputs("prj_a", root)).rejects.toThrow("symlinks");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
