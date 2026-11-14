import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/client.ts";
import { createRepos } from "../../db/repos/index.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { bearerAuth } from "../auth.ts";
import { projectReadinessHandler } from "../handlers/projects.readiness.ts";
import { depsFor, tcpUrl } from "../handlers/projects.test-helpers.ts";
import { startServer } from "../server.ts";

const root = await mkdtemp(join(tmpdir(), "readiness-timeout-"));
const db = await openDatabase({ path: ":memory:" });
const repos = createRepos(db);
await repos.projects.create({
	id: "sample",
	gitUrl: "https://github.com/test/project.git",
	localPath: root,
	defaultBranch: "main",
});
let checks = 0;
const deps = {
	...(await depsFor(repos, new FakeProvider())),
	projectsConfig: { root: join(root, "projects"), gitBinary: "git" },
	readinessSpawn: async (cmd: Parameters<SpawnFn>[0]) => {
		if (cmd.includes("HEAD")) {
			checks++;
			await Bun.sleep(6000);
		}
		return { stdout: cmd.includes("HEAD") ? "a".repeat(40) : ".git", stderr: "", exitCode: 0 };
	},
};
const server = startServer(deps, {
	idleTimeout: 1,
	auth: bearerAuth("fixture-token"),
	routes: [
		{
			method: "POST",
			pattern: "/projects/:id/readiness/check",
			policy: "admin",
			handler: projectReadinessHandler(deps, true),
		},
		{
			method: "POST",
			pattern: "/projects/:id/ordinary",
			policy: "admin",
			handler() {
				return new Promise<Response>(() => {});
			},
		},
	],
});
try {
	const url = tcpUrl(server);
	const denied = await fetch(`${url}/projects/sample/readiness/check`, { method: "POST" });
	const headers = { Authorization: "Bearer fixture-token" };
	const results = await Promise.allSettled([
		fetch(`${url}/projects/sample/readiness/check`, { method: "POST", headers }).then(
			async (r) => ({ status: r.status, body: await r.json() }),
		),
		fetch(`${url}/projects/sample/ordinary`, {
			method: "POST",
			headers,
			signal: AbortSignal.timeout(10000),
		}).then(async (r) => ({ status: r.status, body: await r.json() })),
	]);
	console.log(
		JSON.stringify({
			denied: denied.status,
			checks,
			readiness: results[0],
			ordinary: results[1]?.status,
			ordinaryError: results[1]?.status === "rejected" ? String(results[1].reason) : null,
		}),
	);
	if (results[0]?.status !== "fulfilled") process.exitCode = 1;
} finally {
	await server.stop();
	await db.close();
	await rm(root, { recursive: true, force: true });
}
