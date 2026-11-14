import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../../src/db/client.ts";
import { createRepos } from "../../src/db/repos/index.ts";
import { preparePlanApproval, startApprovedPlan } from "../../src/plan-runs/approval.ts";
import { advancePlanRun, type CoordinatorEmitFn } from "../../src/plan-runs/coordinator.ts";
import {
	createDeploymentGate,
	createProjectDeploymentBlocker,
} from "../../src/plan-runs/deployment-gate.ts";
import { createPlanRunSpawn } from "../../src/plan-runs/dispatch.ts";
import {
	createReviewChangedPathsReader,
	createReviewedMerge,
	createReviewHeadReader,
} from "../../src/plan-runs/review-forge.ts";
import { environmentRepairBudget } from "../../src/plan-runs/task-budget.ts";
import { defaultSpawn } from "../../src/projects/clone.ts";
import { assertProjectReady, checkProjectReadiness } from "../../src/projects/readiness.ts";
import { seedBuiltinAgents } from "../../src/registry/builtins/index.ts";
import { RunEventBroker, reapRun } from "../../src/runs/index.ts";
import { createPrMergeChecker } from "../../src/runs/pr-merge.ts";
import { defaultExec } from "../../src/runs/reap/util.ts";
import { LocalProvider } from "../../src/runtime/local/provider.ts";
import { LocalRunStore } from "../../src/runtime/local/run-store.ts";
import { createBridgeRegistry } from "../../src/server/bridges.ts";
import { publishToolkitVersion } from "../../src/toolkit/versions.ts";
import { createWarrenConfigCache } from "../../src/warren-config/cache.ts";
import { createFixture, TASKS } from "./fixture.ts";
import { LocalAcceptanceForge } from "./local-forge.ts";
export async function realPlanHarness() {
	const fixture = await createFixture();
	const previousDataRoot = process.env.WARREN_DATA_DIR;
	process.env.WARREN_DATA_DIR = join(fixture.root, "data");
	await mkdir(process.env.WARREN_DATA_DIR, { recursive: true });
	const db = await openDatabase({ path: join(fixture.root, "factory.sqlite") });
	const repos = createRepos(db);
	await seedBuiltinAgents(repos.agents);
	const project = await repos.projects.create({
		gitUrl: `file://${fixture.remote}`,
		localPath: fixture.host,
		defaultBranch: "main",
	});
	const forge = new LocalAcceptanceForge(fixture);
	const warrenConfigs = createWarrenConfigCache();
	const readinessDeps = { repos, forge, warrenConfigs, directory: join(fixture.root, "readiness") };
	const readiness = await checkProjectReadiness(readinessDeps, project.id);
	await writeFile(join(fixture.root, "readiness.json"), JSON.stringify(readiness, null, 2));
	if (!readiness.ready)
		throw new Error(`Fixture readiness failed: ${JSON.stringify(readiness.checks)}`);
	const toolkit = await publishToolkitVersion();
	const approval = await preparePlanApproval(
		{
			repos,
			warrenConfigs,
			readiness: await assertProjectReady(readinessDeps, project.id),
			publishToolkit: async () => toolkit,
		},
		{
			commandKey: "real-plan-acceptance",
			projectId: project.id,
			title: "Real Codex code, dependency and UI delivery",
			tasks: TASKS,
		},
	);
	const { planRun } = await startApprovedPlan(repos, approval.id);
	const store = new LocalRunStore();
	const provider = new LocalProvider({
		serverEnv: {
			WARREN_DATA_DIR: process.env.WARREN_DATA_DIR,
			WARREN_CODEX_BIN: process.env.WARREN_CODEX_BIN,
		},
		store,
		drive: { reserveEnvironmentRepair: environmentRepairBudget(repos) },
	});
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
		projectsConfig: { root: fixture.root, gitBinary: "git" },
		projectSpawn: defaultSpawn,
		warrenConfigs,
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
	const mergeDeps = { forge, repos, exec: defaultExec };
	const deploymentDeps = { repos, forge, warrenConfigs };
	return {
		fixture,
		db,
		repos,
		forge,
		project,
		approval,
		planRun,
		provider,
		store,
		bridges,
		toolkit,
		advance: async () =>
			advancePlanRun({
				planRun: await repos.planRuns.require(planRun.id),
				repos,
				spawn,
				emit,
				getIssue: async () => {
					throw new Error("Approved task snapshot must supply the issue");
				},
				getReviewHead: createReviewHeadReader(forge),
				getReviewChangedPaths: createReviewChangedPathsReader(mergeDeps),
				checkPrMerged: createPrMergeChecker({ forge }),
				mergePassedPr: createReviewedMerge(mergeDeps),
				verifyDeployment: createDeploymentGate(deploymentDeps),
				deploymentBlocked: createProjectDeploymentBlocker(deploymentDeps),
				commentOnPr: async () => {},
			}),
		async close() {
			for (const record of store.list())
				await provider.cancel({
					runId: record.runId,
					sandboxId: record.sandboxId,
					providerRunId: record.providerRunId,
				});
			for (const record of store.list()) await record.driveDone;
			await bridges.stopAll();
			await forge.stopApp();
			await db.close();
			if (previousDataRoot === undefined) delete process.env.WARREN_DATA_DIR;
			else process.env.WARREN_DATA_DIR = previousDataRoot;
		},
	};
}
