#!/usr/bin/env bun
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { loadWarrenClientConfigFromFile } from "../src/client/config-file.ts";
import { WarrenClient } from "../src/client/index.ts";
import {
	assertPilotRepository,
	fingerprintSource,
	pilotStopped,
	summarizePilot,
} from "./factory-pilot/report.ts";

interface Options {
	project: string;
	issues?: string;
	plan?: string;
	out: string;
	timeout: string;
}

async function persist(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

async function run(options: Options): Promise<void> {
	const timeout = Number(options.timeout);
	if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120)
		throw new Error("Timeout must be 1–120 minutes.");
	if (Boolean(options.issues) === Boolean(options.plan))
		throw new Error("Provide exactly one of --issues or --plan.");
	const client = pilotClient();
	const project = await client.getProject(options.project);
	assertPilotRepository(project.gitUrl);
	let planId = options.plan;
	if (!planId) {
		const issues =
			options.issues
				?.split(",")
				.map((id) => id.trim())
				.filter(Boolean) ?? [];
		if (!issues.length) throw new Error("At least one issue is required.");
		const created = await client.createPlanRun({
			project: project.id,
			agent: "implementer",
			issues,
		});
		planId = created.planRun.id;
	}
	await observe(client, project.id, project.gitUrl, planId, timeout, options.out);
}

function pilotClient(): WarrenClient {
	const saved = loadWarrenClientConfigFromFile();
	const config = {
		baseUrl: process.env.WARREN_BASE_URL ?? saved?.baseUrl ?? "http://localhost:8080",
		token: process.env.WARREN_API_TOKEN ?? saved?.token,
	};
	return new WarrenClient({
		config,
		fetch: ((input, init) =>
			fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })) as typeof fetch,
	});
}

function observationState(timedOut: boolean, stopped: boolean): string {
	if (timedOut) return "timeout";
	return stopped ? "stopped" : "running";
}

async function observe(
	client: WarrenClient,
	projectId: string,
	repository: string,
	planId: string,
	timeout: number,
	out: string,
): Promise<void> {
	const source = await fingerprintSource(process.cwd());
	const startedAt = new Date().toISOString();
	const reportPath = resolve(out);
	const deadline = Date.now() + timeout * 60_000;
	let lastState = "";
	while (true) {
		const detail = await client.getPlanRun(planId);
		if (detail.planRun.projectId !== projectId) throw new Error("Plan belongs to another project.");
		const summary = summarizePilot(detail);
		const stopped = pilotStopped(summary);
		const timedOut = Date.now() >= deadline;
		const report = {
			schemaVersion: 1,
			repository,
			source,
			startedAt,
			observedAt: new Date().toISOString(),
			observation: observationState(timedOut, stopped),
			...summary,
		};
		await persist(reportPath, report);
		const state = JSON.stringify({
			state: summary.state,
			children: summary.children.map(({ state, reviewStage, mergeReason }) => ({
				state,
				reviewStage,
				mergeReason,
			})),
		});
		if (state !== lastState) {
			process.stdout.write(`${state}\n`);
			lastState = state;
		}
		if (stopped || timedOut) {
			const finalSource = await fingerprintSource(process.cwd());
			await persist(reportPath, {
				...report,
				sourceUnchanged: finalSource.sourceSha256 === source.sourceSha256,
			});
			process.stdout.write(`Pilot evidence: ${reportPath}\n`);
			process.exitCode =
				summary.state === "succeeded" && finalSource.sourceSha256 === source.sourceSha256 ? 0 : 2;
			return;
		}
		await Bun.sleep(5000);
	}
}

if (import.meta.main) {
	const command = new Command("bun scripts/factory-pilot.ts")
		.description(
			"Run or observe a bounded factory-sandbox pilot; record independent review evidence.",
		)
		.requiredOption("--project <id>", "registered factory-sandbox project")
		.option("--issues <ids>", "dispatch these comma-separated test issues")
		.option("--plan <id>", "observe an existing plan without dispatching")
		.option("--out <path>", "portable evidence JSON", "test-results/factory-pilot.json")
		.option("--timeout <minutes>", "bounded observation; timeout leaves the run intact", "45")
		.action(run);
	await command.parseAsync(process.argv).catch(() => {
		// Transport error text can include private endpoint details; local receipt keeps prior state.
		process.stderr.write(
			"Pilot stopped before completion. Check the server, arguments and existing receipt; do not redispatch blindly.\n",
		);
		process.exitCode = 1;
	});
}
