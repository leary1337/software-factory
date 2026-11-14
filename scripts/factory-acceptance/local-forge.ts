import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	DeployRecord,
	DeployRun,
	Forge,
	ForgeDeploys,
	ForgeResult,
	PullRequestRef,
	RepoRef,
} from "../../src/forge/contract.ts";
import { FakeForge } from "../../src/forge/fake/fake-forge.ts";
import { defaultSpawn } from "../../src/projects/clone.ts";
import { spawnGuardedProcess } from "../../src/sandbox/guarded-process.ts";
import { fixtureGitOrThrow as git } from "../../src/workspace/git/test-fixture.ts";
import type { createFixture } from "./fixture.ts";
export class LocalAcceptanceForge extends FakeForge {
	merges: { sha: string; at: string }[] = [];
	releases: DeployRecord[] = [];
	workflowRuns: DeployRun[] = [];
	readonly deploys: ForgeDeploys;
	private app: Awaited<ReturnType<typeof spawnGuardedProcess>> | undefined;
	private appLogs: Promise<void>[] = [];
	private mergedHeads = new Map<number, string>();
	constructor(readonly fixture: Awaited<ReturnType<typeof createFixture>>) {
		super();
		this.setAutoMergeArmCapability(true);
		this.deploys = {
			resolveCommit: async (_ref, branch) => ({
				ok: true,
				value: (await git(fixture.remote, ["rev-parse", branch])).stdout.trim(),
			}),
			readWorkflow: async () => ({
				ok: true,
				value: await readFile(join(fixture.host, ".github/workflows/deploy.yml"), "utf8"),
			}),
			listRuns: async () => ({ ok: true, value: [...this.workflowRuns] }),
			listDeployments: async () => ({ ok: true, value: [...this.releases] }),
			compare: async () => ({ ok: true, value: { aheadBy: 0, commits: [] } }),
			dispatch: async (_ref, _workflow, _branch, inputs) => {
				const sha = inputs?.factory_sha;
				if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Pinned release SHA is required");
				await this.deploy(sha);
				return { ok: true, value: undefined };
			},
		};
	}
	override parseRepoRef(url: string) {
		return super.parseRepoRef(url.replace(/^file:\/\//, "fake://"));
	}
	override async getPullRequest(ref: RepoRef, pr: PullRequestRef) {
		const result = await super.getPullRequest(ref, pr);
		const record = this.store.getPr(ref.key, pr.number);
		if (result.ok && record) {
			result.value.headCommit = (
				await git(this.fixture.remote, ["rev-parse", record.headBranch])
			).stdout.trim();
			if (result.value.lifecycle === "merged")
				result.value = { ...result.value, mergedCommit: this.mergedHeads.get(pr.number) };
		}
		return result;
	}
	async readMergeProtection(_ref: RepoRef, branch: string) {
		return {
			ok: true as const,
			value: {
				baseCommit: (await git(this.fixture.remote, ["rev-parse", branch])).stdout.trim(),
				requiresUpToDate: true,
			},
		};
	}
	override async mergePullRequest(
		ref?: RepoRef,
		pr?: PullRequestRef,
		options?: Parameters<Forge["mergePullRequest"]>[2],
	): Promise<ForgeResult<void>> {
		if (!ref || !pr || !options) throw new Error("Merge arguments required");
		const current = await this.getPullRequest(ref, pr);
		if (!current.ok || current.value.headCommit !== options.expectedHead)
			throw new Error("Reviewed head changed");
		const base = (await git(this.fixture.remote, ["rev-parse", "main"])).stdout.trim();
		await git(this.fixture.remote, ["merge-base", "--is-ancestor", base, options.expectedHead]);
		await git(this.fixture.remote, ["update-ref", "refs/heads/main", options.expectedHead, base]);
		this.mergedHeads.set(pr.number, options.expectedHead);
		this.markMerged(ref, pr);
		this.merges.push({ sha: options.expectedHead, at: new Date().toISOString() });
		return { ok: true, value: undefined };
	}
	override async commentOnPullRequest(): Promise<ForgeResult<void>> {
		return { ok: true, value: undefined };
	}
	private async deploy(sha: string) {
		if (this.workflowRuns.some((run) => run.sha === sha))
			throw new Error("Duplicate publication detected");
		const startedAt = new Date().toISOString();
		const workspace = join(this.fixture.root, "releases", sha);
		await mkdir(join(this.fixture.root, "releases"), { recursive: true });
		await git(this.fixture.root, ["clone", this.fixture.remote, workspace]);
		await git(workspace, ["checkout", "--detach", sha]);
		const install = await defaultSpawn(
			[Bun.which("bun") ?? process.execPath, "install", "--frozen-lockfile"],
			{ cwd: workspace, timeoutMs: 120000 },
		);
		if (install.exitCode) throw new Error("Release dependency install failed");
		await this.stopApp();
		const home = join(this.fixture.root, "application-home");
		await mkdir(home, { recursive: true });
		this.app = await spawnGuardedProcess({
			argv: [Bun.which("bun") ?? process.execPath, "run", "server.ts"],
			cwd: workspace,
			env: {
				HOME: home,
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				APP_SHA: sha,
				PORT: String(this.fixture.port),
			},
			stdin: "ignore",
			lifecyclePath: join(this.fixture.root, "application.lifecycle.json"),
		});
		for (const [name, stream] of [
			["stdout", this.app.proc.stdout],
			["stderr", this.app.proc.stderr],
		] as const) {
			this.appLogs.push(
				(async () => {
					const text = await new Response(stream as ReadableStream<Uint8Array>).text();
					await writeFile(join(this.fixture.root, `application-${name}.log`), text);
				})(),
			);
		}
		for (let i = 0; i < 100; i++) {
			try {
				const response = await fetch(`${this.fixture.base}/version`);
				const body = (await response.json()) as { sha?: string };
				if (body.sha === sha) break;
			} catch {}
			if (i === 99) throw new Error("Actual application failed to start");
			await Bun.sleep(100);
		}
		this.workflowRuns.unshift({
			id: this.workflowRuns.length + 1,
			status: "completed",
			conclusion: "success",
			sha,
			displayTitle: `Factory deploy ${sha}`,
			createdAt: startedAt,
			url: `local-acceptance://release/${sha}`,
		});
		this.releases.unshift({ sha, createdAt: startedAt, state: "success" });
	}
	async stopApp() {
		this.app?.cancel();
		await this.app?.proc.exited;
		await Promise.all(this.appLogs);
		this.appLogs = [];
		this.app = undefined;
	}
}
