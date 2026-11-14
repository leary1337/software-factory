import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { warrenCommitIdentityEnv } from "../bot-identity.ts";
import { ValidationError } from "../core/errors.ts";
import type { ProjectSetupProposal } from "../core/readiness.ts";
import { mintGitCredential } from "../forge/credentials.ts";
import { gitCredentialGitEnv } from "../workspace/git/credential-env.ts";
import { defaultSpawn } from "./clone.ts";
import type { ReadinessDeps } from "./readiness.ts";
import { readinessFingerprint } from "./readiness-store.ts";
import { loadEffectiveProjectConfig } from "./settings.ts";
import { prepareSetupWorkflow } from "./setup-workflow.ts";
/** One deterministic setup branch/PR; existing manifests, dependencies and delivery scripts stay intact. */
export async function proposeProjectSetup(
	deps: ReadinessDeps,
	id: string,
): Promise<ProjectSetupProposal> {
	const project = await deps.repos.projects.require(id);
	const loaded = await loadEffectiveProjectConfig({
		project,
		settings: deps.repos.projectSettings,
		warrenConfigs: deps.warrenConfigs,
	});
	if (loaded.errors.length)
		throw new ValidationError("Fix invalid project settings before proposing setup");
	const config = loaded.defaults ?? {};
	if (!config.qualityGate?.trim())
		throw new ValidationError("Choose the project check command before proposing setup");
	const ref = deps.forge.parseRepoRef(project.gitUrl);
	if (!ref) throw new ValidationError("This forge cannot propose setup");
	const branch = `factory/setup-${readinessFingerprint(config).slice(0, 16)}`;
	const existing = await deps.forge.findPullRequest(ref, {
		headBranch: branch,
		baseBranch: project.defaultBranch,
		state: "all",
	});
	if (!existing.ok) throw new Error("Cannot reconcile the previous setup pull request");
	if (existing.value) return { url: existing.value.webUrl, branch, changed: false };
	const root = await mkdtemp(join(tmpdir(), "factory-setup-"));
	const workspace = join(root, "workspace");
	const spawn = deps.spawn ?? defaultSpawn;
	const credential = await mintGitCredential(deps.forge, project.gitUrl);
	const env = { ...gitCredentialGitEnv(credential), ...warrenCommitIdentityEnv() };
	const git = async (args: string[], cwd = workspace) => {
		const result = await spawn(["git", ...args], { cwd, timeoutMs: 120000, env });
		if (result.exitCode !== 0)
			throw new Error(
				"Setup Git operation failed; inspect repository permissions and branch state",
			);
		return result.stdout.trim();
	};
	try {
		await git(
			[
				"clone",
				"--quiet",
				"--single-branch",
				"--branch",
				project.defaultBranch,
				"--",
				project.gitUrl,
				workspace,
			],
			root,
		);
		await git(["checkout", "-b", branch]);
		const target = join(workspace, ".warren/config.yaml");
		const content = dump(config, { lineWidth: 100, noRefs: true });
		let previous = "";
		try {
			previous = await readFile(target, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const workflows = await prepareSetupWorkflow(workspace, config.deploy);
		if (previous === content && workflows.length === 0)
			return { url: null, branch, changed: false };
		await mkdir(join(workspace, ".warren"), { recursive: true });
		await writeFile(target, content);
		await git(["add", ".warren/config.yaml", ...workflows]);
		await git(["commit", "-m", "chore: configure approved factory project settings"]);
		await git(["remote", "set-url", "origin", project.gitUrl]);
		await git(["push", "origin", `HEAD:refs/heads/${branch}`]);
		const pr = await deps.forge.openPullRequest(ref, {
			headBranch: branch,
			baseBranch: project.defaultBranch,
			title: "Configure project for the factory",
			body: "Apply the selected project profiles, preparation, checks and delivery settings. The application stack, manifests and existing deployment scripts are preserved. If needed, workflow checkout is pinned to the approved commit and automatic triggers become explicit workflow dispatch so releases follow the plan boundaries. Run project readiness checks after this proposal is merged.",
		});
		if (!pr.ok)
			throw new Error(
				"Setup branch is published; the pull request outcome is unconfirmed. Retry to reconcile it.",
			);
		return { url: pr.value.webUrl, branch, changed: true };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
