import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { ForgeDeploys, RepoRef } from "../../forge/contract.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

describe("project deployment handlers", () => {
	let db: WarrenDb;
	let directory: string;
	let handle: ServeHandle;
	let url: string;
	let deploys: ForgeDeploys;
	let dispatches: number;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		directory = await mkdtemp(join(tmpdir(), "factory-deploy-http-"));
		await mkdir(join(directory, ".github/workflows"), { recursive: true });
		await writeFile(join(directory, ".github/workflows/deploy.yml"), "name: Deploy\n");
		const project = await repos.projects.create({
			gitUrl: "https://github.com/o/r",
			localPath: directory,
			defaultBranch: "main",
		});
		dispatches = 0;
		deploys = {
			resolveCommit: async () => ({ ok: true, value: "a".repeat(40) }),
			readWorkflow: async () => ({
				ok: true,
				value: "",
			}),
			listDeployments: async () => ({
				ok: true,
				value: [
					...Array.from({ length: 5 }, () => ({
						sha: "bad",
						createdAt: "today",
						state: "failure" as const,
					})),
					{ sha: "live", createdAt: "yesterday", state: "success" },
				],
			}),
			listRuns: async () => ({ ok: true, value: [] }),
			compare: async () => ({ ok: true, value: { aheadBy: 3, commits: [] } }),
			dispatch: async () => {
				dispatches++;
				return { ok: true, value: undefined };
			},
		};
		const deps = await depsFor(repos, new FakeProvider());
		Object.assign(deps.forge ?? {}, {
			deploys,
			parseRepoRef: () => ({ forge: "github", key: "o/r" }) as RepoRef,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		url = `${tcpUrl(handle)}/projects/${project.id}/deploy`;
	});
	afterEach(async () => {
		await handle.stop();
		await db.close();
		await rm(directory, { recursive: true, force: true });
	});
	test("returns a release older than five failures through the HTTP route", async () => {
		const response = await fetch(url);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.current.sha).toBe("live");
		expect(body.currentState).toBe("deployed");
		expect(body.behind.count).toBe(3);
		expect(body.history).toHaveLength(5);
	});
	test("returns an error without dispatch when workflow status cannot be read", async () => {
		deploys.listRuns = async () => ({
			ok: false,
			error: { kind: "unauthorized", detail: "denied" },
		});
		const response = await fetch(url, { method: "POST" });
		expect(response.ok).toBe(false);
		expect(await response.text()).toContain("Cannot check active deployments");
		expect(dispatches).toBe(0);
	});
});
