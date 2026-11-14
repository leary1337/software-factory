import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { createWarrenConfigCache } from "../../warren-config/cache.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

describe("project settings API", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle;
	let path: string;
	let id: string;
	const cache = createWarrenConfigCache();
	const profiles = {
		implementation: { runtime: "codex", model: "gpt-6.1-sol" },
		review: { runtime: "codex", model: "gpt-6-astra" },
	};
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		path = await mkdtemp(join(tmpdir(), "project-settings-"));
		id = (
			await repos.projects.create({
				gitUrl: "https://github.com/example/project",
				localPath: path,
				defaultBranch: "main",
			})
		).id;
		const deps = await depsFor(repos, new FakeProvider());
		handle = startServer(
			{ ...deps, warrenConfigs: cache },
			{
				transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
				auth: NO_AUTH,
				logger: silentLogger,
			},
		);
	});
	afterEach(async () => {
		await handle.stop();
		await db.close();
		await rm(path, { recursive: true, force: true });
		cache.clear();
	});
	const get = () => fetch(`${tcpUrl(handle)}/projects/${id}/settings`);
	const patch = (revision: number, changes: unknown) =>
		fetch(`${tcpUrl(handle)}/projects/${id}/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ revision, patch: changes }),
		});

	test("saves independent profiles and preserves sibling settings across config refresh", async () => {
		expect((await (await get()).json()).revision).toBe(0);
		expect((await patch(0, { preparation: { recipe: "go" } })).status).toBe(200);
		const saved = await patch(1, { executionProfiles: profiles });
		expect(saved.status).toBe(200);
		expect((await saved.json()).effective.executionProfiles).toEqual(profiles);
		await mkdir(join(path, ".warren"));
		await writeFile(join(path, ".warren/config.yaml"), "qualityGate: go test ./...\n");
		cache.invalidate(id);
		const body = await (await get()).json();
		expect(body.revision).toBe(2);
		expect(body.effective.preparation.recipe).toBe("go");
		expect(body.effective.qualityGate).toBe("go test ./...");
		expect(body.effective.executionProfiles).toEqual(profiles);
		const config = await fetch(`${tcpUrl(handle)}/projects/${id}/warren-config`);
		expect((await config.json()).defaults.executionProfiles).toEqual(profiles);
	});

	test("rejects stale concurrent changes without losing either role", async () => {
		expect((await patch(0, { executionProfiles: profiles })).status).toBe(200);
		expect((await patch(0, { preparation: { recipe: "go" } })).status).toBe(409);
		expect((await (await get()).json()).effective.executionProfiles).toEqual(profiles);
	});

	test.each([
		{ runtime: "claude-code", model: "claude-opus-4-7" },
		{ runtime: "codex", model: "claude-opus-4-7" },
		{ runtime: "codex", model: "" },
	])("rejects unavailable or incompatible execution profile %j", async (implementation) => {
		expect((await patch(0, { executionProfiles: { ...profiles, implementation } })).status).toBe(
			400,
		);
		expect((await (await get()).json()).revision).toBe(0);
	});

	test("preserves an explicit unknown model without silently choosing another", async () => {
		const requested = { ...profiles, review: { runtime: "codex", model: "experimental-model" } };
		const response = await patch(0, { executionProfiles: requested });
		expect(response.status).toBe(200);
		expect((await response.json()).effective.executionProfiles).toEqual(requested);
	});

	test("isolates projects and removes settings when the project is deleted", async () => {
		await patch(0, { executionProfiles: profiles });
		const second = await repos.projects.create({
			gitUrl: "https://github.com/example/second",
			localPath: path,
			defaultBranch: "main",
		});
		expect(await repos.projectSettings.get(second.id)).toBeNull();
		await repos.projects.delete(id);
		expect(await repos.projectSettings.get(id)).toBeNull();
		expect((await get()).status).toBe(404);
	});
});
