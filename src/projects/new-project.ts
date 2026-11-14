import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";
import { warrenCommitIdentityEnv } from "../bot-identity.ts";
import { ValidationError } from "../core/errors.ts";
import type { NewProjectPreview, NewProjectRequest } from "../core/new-project.ts";
import { mintGitCredential } from "../forge/credentials.ts";
import { ensurePrivateRepository } from "../forge/repository-creation.ts";
import { DefaultsConfigSchema } from "../warren-config/schema.ts";
import { gitCredentialGitEnv } from "../workspace/git/credential-env.ts";
import { defaultSpawn } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { addProject } from "./manage.ts";
import type { ReadinessDeps } from "./readiness.ts";
import { readinessFingerprint } from "./readiness-store.ts";
import { updateProjectSettings } from "./settings.ts";
import { scaffold } from "./template.ts";
export function previewNewProject(request: NewProjectRequest): NewProjectPreview {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(request.owner) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(request.name)
	)
		throw new ValidationError("Choose a valid repository owner and name");
	if (request.template !== "go-react")
		throw new ValidationError(
			"Unsupported project template; choose the explicit Go/React template or connect an existing repository",
		);
	const settings = DefaultsConfigSchema.parse({
		qualityGate: "./scripts/check.sh",
		memoryEnabled: false,
		preparation: {
			recipe: "command",
			command: "(cd web && bun install --frozen-lockfile) && go mod download",
		},
		...request.settings,
	});
	const repository = `https://github.com/${request.owner}/${request.name}`;
	return {
		request,
		repository,
		stack: ["Go", "React", "TypeScript", "Bun"],
		settings,
		confirmation: readinessFingerprint({ request, settings, repository }),
		deliveryConfigured:
			settings.deploy?.autoDeploy === true && Boolean(settings.deploy.verification),
	};
}
export async function createNewProject(
	deps: ReadinessDeps & { projectsConfig: ProjectsConfig; creationDirectory: string },
	request: NewProjectRequest,
	confirmation: string,
) {
	const preview = previewNewProject(request);
	if (preview.confirmation !== confirmation)
		throw new ValidationError("Confirm the exact project preview before creating a repository");
	const existing = await deps.repos.projects.findByGitUrl(preview.repository);
	if (existing) return { project: existing, created: false, ready: false };
	const root = join(deps.creationDirectory, request.owner, request.name);
	await mkdir(root, { recursive: true });
	const marker = join(root, "request.json");
	if (existsSync(marker)) {
		const prior = JSON.parse(await readFile(marker, "utf8")) as { confirmation: string };
		if (prior.confirmation !== confirmation)
			throw new ValidationError("This repository already has a different creation request");
	} else await writeFile(marker, JSON.stringify({ confirmation }), { flag: "wx", mode: 0o600 });
	const workspace = join(root, "workspace");
	const spawn = deps.spawn ?? defaultSpawn;
	const credential = await mintGitCredential(deps.forge, preview.repository);
	const env = { ...gitCredentialGitEnv(credential), ...warrenCommitIdentityEnv() };
	const git = async (args: string[]) => {
		const result = await spawn(["git", ...args], { cwd: workspace, timeoutMs: 120000, env });
		if (result.exitCode !== 0)
			throw new Error(
				"New-project Git operation failed; retry the same request after resolving repository access",
			);
		return result.stdout.trim();
	};
	if (!existsSync(workspace)) {
		scaffold(workspace, request.name, `github.com/${request.owner}/${request.name}`);
		await mkdir(join(workspace, ".warren"), { recursive: true });
		await writeFile(
			join(workspace, ".warren/config.yaml"),
			dump(preview.settings, { lineWidth: 100, noRefs: true }),
		);
	}
	if (!existsSync(join(workspace, ".git"))) await git(["init", "-b", "main"]);
	const head = await spawn(["git", "rev-parse", "--verify", "HEAD"], { cwd: workspace });
	if (head.exitCode !== 0) {
		await git(["add", "."]);
		await git(["commit", "-m", "chore: create approved Go/React project"]);
	}
	await ensurePrivateRepository(request.owner, request.name, workspace, spawn);
	const remote = await spawn(["git", "remote", "get-url", "origin"], { cwd: workspace });
	if (remote.exitCode !== 0) await git(["remote", "add", "origin", preview.repository]);
	else if (remote.stdout.trim() !== preview.repository)
		throw new ValidationError("Creation workspace has a different remote; it was preserved");
	await git(["push", "-u", "origin", "main"]);
	const project = await addProject({
		repo: deps.repos.projects,
		config: deps.projectsConfig,
		gitUrl: preview.repository,
		defaultBranch: "main",
		forge: deps.forge,
		gitCredential: credential,
		spawn,
	});
	await updateProjectSettings({
		project,
		settings: deps.repos.projectSettings,
		revision: 0,
		patch: preview.settings,
	});
	return { project, created: true, ready: false };
}
