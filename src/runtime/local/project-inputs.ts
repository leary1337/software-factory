/** Host-provisioned data, scoped by project id; never resolved from agent configuration. */
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SandboxProfile } from "../../sandbox/types.ts";

export function withProjectInputs(
	profile: SandboxProfile,
	path: string | undefined,
): SandboxProfile {
	if (!path) return profile;
	return {
		...profile,
		projectInputsPath: path,
		readOnlyMounts: [...profile.readOnlyMounts, path],
		setEnv: { ...profile.setEnv, WARREN_PROJECT_INPUTS: path },
	};
}

export async function resolveProjectInputs(
	projectId: string | undefined,
	root = process.env.WARREN_PROJECT_INPUTS_ROOT,
): Promise<string | undefined> {
	if (!root || !projectId) return undefined;
	if (!isAbsolute(root) || !/^[a-zA-Z0-9_-]+$/.test(projectId))
		throw new Error("Invalid host project-input configuration");
	const canonicalRoot = await realpath(root);
	const path = join(canonicalRoot, projectId);
	const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (stat === null) return undefined;
	if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path)
		throw new Error("Project inputs must be a real directory owned by the host");
	for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isFile())
			throw new Error("Project inputs cannot contain symlinks or special files");
	}
	return path;
}
