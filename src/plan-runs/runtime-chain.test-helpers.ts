import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import type { Forge, ForgeResult, PullRequestRef, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { defaultSpawn } from "../projects/clone.ts";
import { seedBuiltinAgents } from "../registry/builtins/index.ts";
import { RunEventBroker, reapRun } from "../runs/index.ts";
import { createPrMergeChecker } from "../runs/pr-merge.ts";
import { defaultExec } from "../runs/reap/util.ts";
import { codexAdapter } from "../runtime/adapters/codex.ts";
import type { AgentRuntimeAdapter } from "../runtime/adapters/types.ts";
import { LocalProvider } from "../runtime/local/provider.ts";
import { LocalRunStore } from "../runtime/local/run-store.ts";
import { createBridgeRegistry } from "../server/bridges.ts";
import { createWarrenConfigCache } from "../warren-config/cache.ts";
import { fixtureGitOrThrow } from "../workspace/git/test-fixture.ts";
import { advancePlanRun, type CoordinatorEmitFn } from "./coordinator.ts";
import { createPlanRunSpawn } from "./dispatch.ts";
import { createReviewedMerge, createReviewHeadReader } from "./review-forge.ts";

class LocalForge extends FakeForge {
	merges = 0;
	readonly comments = new Set<string>();
	constructor(readonly remote: string) {
		super();
		this.setAutoMergeArmCapability(true);
	}
	override parseRepoRef(url: string) {
		return super.parseRepoRef(url.replace(/^file:\/\//, "fake://"));
	}
	override async getPullRequest(ref: RepoRef, pr: PullRequestRef) {
		const result = await super.getPullRequest(ref, pr);
		const record = this.store.getPr(ref.key, pr.number);
		if (result.ok && record)
			result.value.headCommit = (
				await fixtureGitOrThrow(this.remote, ["rev-parse", record.headBranch])
			).stdout.trim();
		return result;
	}
	async readMergeProtection(_ref: RepoRef, branch: string) {
		return {
			ok: true as const,
			value: {
				baseCommit: (await fixtureGitOrThrow(this.remote, ["rev-parse", branch])).stdout.trim(),
				requiresUpToDate: true,
			},
		};
	}
	override async mergePullRequest(
		ref?: RepoRef,
		pr?: PullRequestRef,
		options?: Parameters<Forge["mergePullRequest"]>[2],
	): Promise<ForgeResult<void>> {
		if (!ref || !pr || !options) throw new Error("merge arguments required");
		const current = await this.getPullRequest(ref, pr);
		if (!current.ok || current.value.headCommit !== options.expectedHead)
			throw new Error("review head changed");
		await fixtureGitOrThrow(this.remote, ["update-ref", "refs/heads/main", options.expectedHead]);
		this.markMerged(ref, pr);
		this.merges++;
		return { ok: true, value: undefined };
	}
	override async commentOnPullRequest(
		_ref?: RepoRef,
		_pr?: PullRequestRef,
		body?: string,
		key?: string,
	): Promise<ForgeResult<void>> {
		this.comments.add(key ?? body ?? "");
		return { ok: true, value: undefined };
	}
}

function nextVerdict(verdicts: string[]): string {
	return verdicts.shift() ?? "PASS";
}

export async function runtimeChain(
	verdicts: string[],
	gate = "test -f .warren/config.yaml && test -f change-1.txt",
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "factory-chain-")));
	const remote = join(root, "remote.git");
	const host = join(root, "host");
	await fixtureGitOrThrow(root, ["init", "--bare", "-b", "main", remote]);
	await fixtureGitOrThrow(root, ["clone", remote, host]);
	await mkdir(join(host, ".warren"));
	await writeFile(
		join(host, ".warren/config.yaml"),
		`qualityGate: ${gate}\nagent:\n  skipGitHooks: true\npr:\n  autoMerge:\n    method: squash\n`,
	);
	await fixtureGitOrThrow(host, ["add", "."]);
	await fixtureGitOrThrow(host, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-m",
		"init",
	]);
	await fixtureGitOrThrow(host, ["push", "origin", "main"]);
	const db = await openDatabase({ path: join(root, "warren.db") });
	const repos = createRepos(db);
	await seedBuiltinAgents(repos.agents);
	const project = await repos.projects.create({
		gitUrl: `file://${remote}`,
		localPath: host,
		defaultBranch: "main",
	});
	const { planRun } = await repos.planRuns.create({
		projectId: project.id,
		planId: "fixture",
		agentName: "implementer",
		children: [
			{ seq: 1, seedId: "a" },
			{ seq: 2, seedId: "b" },
		],
	});
	const store = new LocalRunStore();
	const roles: string[] = [];
	const adapter: AgentRuntimeAdapter = {
		...codexAdapter,
		prepareHome: async () => async () => {},
		recoverHome: async () => {},
		createEventParser: () => (line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		},
		buildSpawnCommand(ctx) {
			const role = ctx.prompt.includes("You review one pull request cold")
				? "reviewer"
				: ctx.prompt.includes("You fix what an automated review")
					? "rework"
					: "implementer";
			roles.push(role);
			let script: string;
			if (role === "reviewer") {
				const verdict = nextVerdict(verdicts);
				script = reviewerScript(verdict, roles.length);
			} else {
				script = `set -e; echo ${role} > change-${roles.length}.txt; git add change-${roles.length}.txt; git commit -m ${role}; printf '%s\\n' '{"kind":"state_change","stream":"system","payload":{"type":"result","result":"Committed.","total_cost_usd":0}}'`;
			}
			return { argv: ["/bin/sh", "-c", script] };
		},
	};
	const provider = new LocalProvider({
		serverEnv: { WARREN_DATA_DIR: join(root, "data") },
		store,
		drive: { registry: { get: () => adapter } },
	});
	const forge = new LocalForge(remote);
	const broker = new RunEventBroker();
	const bridges = createBridgeRegistry({
		repos,
		broker,
		runtimeProvider: provider,
		autoOpenPr: { enabled: true, warrenBaseUrl: null },
		reap: (input) => reapRun({ ...input, forge }),
	});
	const spawn = createPlanRunSpawn({
		repos,
		runtimeProvider: provider,
		bridges,
		projectsConfig: { root, gitBinary: "git" },
		projectSpawn: defaultSpawn,
		warrenConfigs: createWarrenConfigCache(),
		seedsCli: { sdBinary: "sd", spawn: defaultSpawn },
	});
	const emit: CoordinatorEmitFn = async (runId, kind, payload) => {
		await repos.events.append({
			runId,
			kind,
			payload,
			stream: "system",
			ts: new Date().toISOString(),
			sandboxEventSeq: ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1,
		});
	};
	const advance = async () =>
		advancePlanRun({
			planRun: await repos.planRuns.require(planRun.id),
			repos,
			spawn,
			emit,
			getIssue: async (_project, id) => ({ id, title: `Write fixture ${id}`, status: "open" }),
			getReviewHead: createReviewHeadReader(forge),
			checkPrMerged: createPrMergeChecker({ forge }),
			mergePassedPr: createReviewedMerge({ forge, repos, exec: defaultExec }),
			commentOnPr: async (url, body, key) => {
				const ref = forge.parseRepoRef(url);
				if (!ref) throw new Error("invalid PR");
				await forge.commentOnPullRequest(
					ref,
					{
						forge: "fake",
						key: String(url.split("/").at(-1)),
						number: Number(url.split("/").at(-1)),
						webUrl: url,
					},
					body,
					key,
				);
			},
		});
	return {
		root,
		db,
		repos,
		provider,
		bridges,
		store,
		planRun,
		roles,
		forge,
		advance,
		broker,
		async drain() {
			for (let i = 0; i < 500 && bridges.size() > 0; i++) await Bun.sleep(20);
			if (bridges.size()) throw new Error("bridge did not drain");
		},
		async close() {
			await bridges.stopAll();
			for (const record of store.list())
				await provider.cancel({
					runId: record.runId,
					sandboxId: record.sandboxId,
					providerRunId: record.providerRunId,
				});
			await db.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

function reviewerScript(verdict: string, step: number): string {
	const text = JSON.stringify({
		kind: "text",
		stream: "stdout",
		payload: { text: "Review completed." },
	});
	const manifest = JSON.stringify({
		version: 1,
		findings:
			verdict === "CHANGES" || verdict === "STALLED"
				? [
						{
							id: `fixture-${step}`,
							title: "Missing expected change",
							command: `sh "$WARREN_REPRO_DIR/repro.sh" change-${verdict === "STALLED" ? "never" : step + 1}.txt`,
							files: [{ path: "repro.sh", contents: 'test -f "$1"\n' }],
						},
					]
				: [],
	});
	const envelope = JSON.stringify({
		kind: "state_change",
		stream: "system",
		payload: {
			type: "result",
			result: `VERDICT: ${verdict === "STALLED" ? "CHANGES" : verdict}\nREVIEWED_COMMIT: REVIEW_SHA\nQUALITY_GATE: NOT_RUN\n\nFixture report.`,
		},
	});
	return verdict === "CRASH"
		? "exit 1"
		: verdict === "WAIT"
			? "sleep 30"
			: `printf '%s\\n' '${text}'; printf '%s' '${manifest}' > "$HOME/warren-review.json"; sha=$(git rev-parse HEAD); printf '%s\\n' '${envelope.replace("REVIEW_SHA", "'\"$sha\"'")}'`;
}
