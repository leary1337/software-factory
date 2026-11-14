import { ValidationError } from "../core/errors.ts";
import { defaultSpawn, type SpawnFn } from "../projects/clone.ts";
/** GitHub repository creation stays inside the forge boundary and uses the already authorized CLI. */
export async function ensurePrivateRepository(
	owner: string,
	name: string,
	cwd: string,
	spawn: SpawnFn = defaultSpawn,
): Promise<void> {
	const repository = `${owner}/${name}`;
	const existing = await spawn(["gh", "api", `repos/${repository}`], { cwd, timeoutMs: 30000 });
	if (existing.exitCode === 0) {
		const data = JSON.parse(existing.stdout) as { full_name?: string; private?: boolean };
		if (data.full_name?.toLowerCase() !== repository.toLowerCase() || data.private !== true)
			throw new ValidationError(
				"Existing repository does not match the approved private repository",
			);
		return;
	}
	if (!/(?:HTTP 404|Not Found \(HTTP 404\))/.test(existing.stderr))
		throw new Error(
			"Cannot establish repository availability; inspect GitHub authorization before retrying",
		);
	const created = await spawn(["gh", "repo", "create", repository, "--private"], {
		cwd,
		timeoutMs: 30000,
	});
	if (created.exitCode !== 0)
		throw new Error(
			"Repository creation outcome is unconfirmed; retry to reconcile the named repository",
		);
}
