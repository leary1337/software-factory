import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { gitRepoContextScrubEnv } from "../../bot-identity.ts";
import type { ProjectRow } from "../../db/schema.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import { type DefaultsConfig, parseDefaultsConfig } from "../../warren-config/schema.ts";
import { gitCredentialGitEnv } from "../../workspace/git/credential-env.ts";
import type { SpawnRunInput } from "./types.ts";

/** A clean remote snapshot prevents a PR or a shared clone from supplying its own checks. */
export async function readApprovedDefaults(
	input: Pick<SpawnRunInput, "reviewBaseBranch" | "projectSpawn" | "gitCredential">,
	project: Pick<ProjectRow, "localPath" | "gitUrl" | "defaultBranch">,
): Promise<DefaultsConfig> {
	const root = await mkdtemp(join(dirname(project.localPath), ".review-policy-"));
	const spawn = input.projectSpawn ?? defaultSpawn;
	const env = {
		...gitRepoContextScrubEnv(),
		...Object.fromEntries(
			Object.keys(process.env)
				.filter((key) => key.startsWith("GIT_"))
				.map((key) => [key, undefined]),
		),
		...gitCredentialGitEnv(input.gitCredential),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	const run = async (
		args: string[],
		failure = "Cannot read approved review policy from the base branch.",
	) => {
		const result = await spawn(["git", ...args], { cwd: root, env, timeoutMs: 30000 });
		if (result.exitCode !== 0) throw new Error(failure);
		return result.stdout;
	};
	try {
		const branch = input.reviewBaseBranch ?? project.defaultBranch;
		await run(["check-ref-format", `refs/heads/${branch}`]);
		await run(["init", "--bare", "--template="]);
		await run([
			"fetch",
			"--no-tags",
			"--",
			project.gitUrl,
			`refs/heads/${branch}:refs/review/base`,
		]);
		const raw = await run(
			["show", "refs/review/base:.warren/config.yaml"],
			"Cannot read .warren/config.yaml from the approved base branch. Configure qualityGate there, then retry review.",
		);
		const parsed = parseDefaultsConfig(load(raw));
		if (!parsed.ok) throw new Error("Approved base branch must configure valid project defaults.");
		return parsed.value;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
