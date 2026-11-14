import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatError, ValidationError } from "../core/errors.ts";
import type { ProjectReadiness, ReadinessCheck, ReadinessEvidence } from "../core/readiness.ts";
import type { Repos } from "../db/repos/index.ts";
import type { Forge } from "../forge/contract.ts";
import { mintGitCredential } from "../forge/credentials.ts";
import { preparationEnvironment } from "../preparation/environment.ts";
import { resolvePreparation } from "../preparation/recipe.ts";
import { resolveExecutionProfiles } from "../runtime/adapters/execution-profiles.ts";
import { assertFactoryRuntimeReady as runtimeReady } from "../runtime/adapters/factory-readiness.ts";
import { stopAgentProcess } from "../runtime/local/git-pin.ts";
import { runHostProcess } from "../runtime/local/process-spawn.ts";
import { runIndependentQualityGate } from "../runtime/local/quality-gate.ts";
import { type LocalRunRecord, LocalRunStore } from "../runtime/local/run-store.ts";
import type { SandboxProfile } from "../sandbox/types.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { gitCredentialGitEnv } from "../workspace/git/credential-env.ts";
import { defaultSpawn, type SpawnFn } from "./clone.ts";
import { validateDeploymentWorkflow } from "./deployment-workflow.ts";
import { checkMergeReadiness } from "./readiness-merge.ts";
import { readinessFingerprint, readReadiness, saveReadiness } from "./readiness-store.ts";
import { loadEffectiveProjectConfig } from "./settings.ts";
export interface ReadinessDeps {
	repos: Pick<Repos, "projects" | "projectSettings">;
	forge: Forge;
	directory: string;
	warrenConfigs?: WarrenConfigCache;
	spawn?: SpawnFn;
	runtimeReady?: () => Promise<void>;
}
async function checked(checks: ReadinessCheck[], name: string, work: () => Promise<string>) {
	try {
		checks.push({ name, ok: true, message: await work() });
	} catch (error) {
		checks.push({ name, ok: false, message: formatError(error) });
	}
}
async function state(deps: ReadinessDeps, id: string) {
	const project = await deps.repos.projects.require(id);
	deps.warrenConfigs?.invalidate(id);
	const config = await loadEffectiveProjectConfig({
		project,
		settings: deps.repos.projectSettings,
		warrenConfigs: deps.warrenConfigs,
	});
	const head = await (deps.spawn ?? defaultSpawn)(["git", "rev-parse", "HEAD"], {
		cwd: project.localPath,
		timeoutMs: 10000,
	});
	const commit = head.exitCode === 0 ? head.stdout.trim() : "";
	return {
		project,
		config,
		commit,
		fingerprint: readinessFingerprint({
			settings: config.defaults,
			errors: config.errors,
			commit,
			branch: project.defaultBranch,
		}),
	};
}
export async function getProjectReadiness(
	deps: ReadinessDeps,
	id: string,
): Promise<ProjectReadiness> {
	const current = await state(deps, id);
	const saved = await readReadiness(deps.directory, id);
	const stale = !saved || saved.fingerprint !== current.fingerprint;
	return {
		ready: !stale && saved.ready,
		stale,
		fingerprint: current.fingerprint,
		commit: current.commit,
		checkedAt: saved?.checkedAt,
		checks: stale
			? [
					{
						name: "readiness",
						ok: false,
						message: "Run readiness checks for the current project settings and source version",
					},
				]
			: saved.checks,
		...(saved?.setupPrUrl ? { setupPrUrl: saved.setupPrUrl } : {}),
	};
}
export async function assertProjectReady(
	deps: ReadinessDeps,
	id: string,
): Promise<ReadinessEvidence> {
	const result = await getProjectReadiness(deps, id);
	if (!result.ready || !result.checkedAt || !result.commit)
		throw new ValidationError(
			"Project is not ready for autonomous work. Run readiness checks and resolve the reported blockers.",
		);
	return { fingerprint: result.fingerprint, checkedAt: result.checkedAt, commit: result.commit };
}
function assertArtifactSupport(required: string | undefined, forge: Forge): void {
	if (required && !forge.deploys?.readVerificationArtifact)
		throw new Error("The forge cannot read the configured workflow verification evidence");
}
async function remoteChecks(
	deps: ReadinessDeps,
	current: Awaited<ReturnType<typeof state>>,
	checks: ReadinessCheck[],
) {
	const { project, config } = current;
	const settings = config.defaults;
	await checked(checks, "permissions", async () => {
		const credential = await mintGitCredential(deps.forge, project.gitUrl);
		const result = await (deps.spawn ?? defaultSpawn)(
			["git", "push", "--dry-run", "origin", `HEAD:refs/heads/factory/readiness-${project.id}`],
			{ cwd: project.localPath, timeoutMs: 30000, env: gitCredentialGitEnv(credential) },
		);
		if (result.exitCode !== 0) throw new Error("Repository write access could not be verified");
		return "Repository credentials permit a branch push";
	});
	await checked(checks, "merge", () =>
		checkMergeReadiness({
			forge: deps.forge,
			gitUrl: project.gitUrl,
			branch: project.defaultBranch,
			commit: current.commit,
			policy: settings?.pr?.autoMerge,
		}),
	);

	await checked(checks, "delivery", async () => {
		const deploy = settings?.deploy;
		if (!deploy?.autoDeploy || !deploy.verification || !deploy.shaInput)
			throw new Error(
				"Choose delivery and its version, availability and read-only scenario checks",
			);
		const ref = deps.forge.parseRepoRef(project.gitUrl);
		if (!ref || !deps.forge.deploys) throw new Error("Deployment is unavailable for this forge");
		assertArtifactSupport(deploy.verification.artifactName, deps.forge);
		const workflow = await deps.forge.deploys.readWorkflow(
			ref,
			deploy.workflow ?? "deploy.yml",
			project.defaultBranch,
		);
		if (!workflow.ok || !validateDeploymentWorkflow(workflow.value, deploy.shaInput))
			throw new Error("Deployment workflow must pin the selected commit");
		const runs = await deps.forge.deploys.listRuns(ref, deploy.workflow ?? "deploy.yml", 1);
		if (!runs.ok) throw new Error("Cannot read deployment workflow status");
		return "Delivery workflow pins the commit; application checks configured";
	});
}
/** Execute preparation and checks in a disposable pinned checkout, never in the owner's source tree. */
export async function checkProjectReadiness(
	deps: ReadinessDeps,
	id: string,
): Promise<ProjectReadiness> {
	const current = await state(deps, id);
	const checks: ReadinessCheck[] = [];
	const root = await mkdtemp(join(tmpdir(), "factory-readiness-"));
	const home = join(root, "homes", "readiness");
	await mkdir(home, { recursive: true });
	let pending: LocalRunRecord | undefined;
	try {
		await checked(checks, "environment", async () => {
			await (deps.runtimeReady ?? runtimeReady)();
			return "Local Codex and authorization are available";
		});
		await checked(checks, "profiles", async () => {
			if (current.config.errors.length)
				throw new Error(current.config.errors.map((e) => e.message).join("; "));
			resolveExecutionProfiles(current.config.defaults);
			return "Executor and reviewer profiles are valid";
		});
		const common = await (deps.spawn ?? defaultSpawn)(["git", "rev-parse", "--git-common-dir"], {
			cwd: current.project.localPath,
			timeoutMs: 10000,
		});
		const profile: SandboxProfile = {
			workspace: current.project.localPath,
			home,
			network: "open",
			readOnlyMounts: [],
			allowedDomains: [],
			envPassthrough: [],
			setEnv: {},
			toolchainPaths: [...new Set((process.env.PATH ?? "").split(":"))],
			timeoutMs: current.config.defaults?.taskBudgets?.runMs ?? 3600000,
			workspaceGit: {
				gitDir: resolve(current.project.localPath, common.stdout.trim()),
				hostGitDir: resolve(current.project.localPath, common.stdout.trim()),
				sharedObjects: join(resolve(current.project.localPath, common.stdout.trim()), "objects"),
				protectedPaths: [],
				deniedRoots: [],
			},
		};
		await checked(checks, "preparation", async () => {
			const plan = await resolvePreparation(
				current.project.localPath,
				current.config.defaults?.preparation,
			);
			await preparationEnvironment(
				profile,
				plan,
				current.config.defaults?.preparation,
				join(root, "download-cache"),
			);
			return `Preparation recipe: ${plan.recipe}`;
		});
		await checked(checks, "checks", async () => {
			const command = current.config.defaults?.qualityGate;
			if (!command?.trim()) throw new Error("Configure the independent quality check command");
			const store = new LocalRunStore();
			const record = store.create({
				runId: "readiness",
				sandboxId: "readiness",
				workspacePath: profile.workspace,
				homePath: home,
				branch: current.project.defaultBranch,
			});
			pending = record;
			await runIndependentQualityGate(
				store,
				record,
				{ command, commit: current.commit, preparation: current.config.defaults?.preparation },
				profile,
				undefined,
				{
					spawn: (profile, command) =>
						runHostProcess(profile, command, { lifecyclePath: `${home}.lifecycle.json` }),
				},
			);
			return "Preparation and independent checks passed on the pinned source commit";
		});
		await remoteChecks(deps, current, checks);
	} finally {
		await stopAgentProcess(pending?.proc);
		await rm(root, { recursive: true, force: true });
	}
	const result: ProjectReadiness = {
		ready: checks.every((check) => check.ok),
		stale: false,
		fingerprint: current.fingerprint,
		commit: current.commit,
		checkedAt: new Date().toISOString(),
		checks,
	};
	await saveReadiness(deps.directory, id, result);
	return result;
}
