import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.ts";
import { createRepos } from "../db/repos/index.ts";
import type { RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { defaultSpawn, type SpawnFn } from "./clone.ts";
import { createNewProject, previewNewProject } from "./new-project.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("new project", () => {
	test("shows the supported stack and rejects changed or unsupported confirmation", async () => {
		const preview = previewNewProject({ owner: "owner", name: "app", template: "go-react" });
		expect(preview.stack).toEqual(["Go", "React", "TypeScript", "Bun"]);
		expect(preview.deliveryConfigured).toBe(false);
		expect(() =>
			previewNewProject({ owner: "../escape", name: "app", template: "go-react" }),
		).toThrow();
		expect(() =>
			previewNewProject({ ...preview.request, template: "python" as "go-react" }),
		).toThrow("Unsupported");
	});
	test("reconciles the same creation request without duplicating the repository or project", async () => {
		const root = await mkdtemp(join(tmpdir(), "new-project-test-"));
		roots.push(root);
		const db = await openDatabase({ path: ":memory:" });
		try {
			const repos = createRepos(db);
			const remote = join(root, "remote.git");
			await defaultSpawn(["git", "init", "--bare", remote], { cwd: root });
			await defaultSpawn(["git", "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], {
				cwd: root,
			});
			let exists = false;
			let creates = 0;
			const repository = "https://github.com/owner/app";
			const gh = async (cmd: readonly string[]) => {
				if (cmd[1] === "api")
					return exists
						? {
								exitCode: 0,
								stdout: JSON.stringify({ full_name: "owner/app", private: true }),
								stderr: "",
							}
						: { exitCode: 1, stdout: "", stderr: "HTTP 404" };
				exists = true;
				creates++;
				return { exitCode: 0, stdout: "", stderr: "" };
			};
			const spawn: SpawnFn = async (cmd, opts) => {
				if (cmd[0] === "gh") return gh(cmd);
				if (cmd[0] === "git" && cmd[1] === "remote" && cmd[2] === "get-url") {
					const result = await defaultSpawn(cmd, opts);
					return result.exitCode === 0 ? { ...result, stdout: repository } : result;
				}
				return defaultSpawn(
					cmd.map((value) => (value === repository ? remote : value)),
					opts,
				);
			};
			await mkdir(join(root, "projects"));
			const forge = Object.assign(new FakeForge(), {
				parseRepoRef: () => ({ forge: "fake", key: "owner/app" }) as RepoRef,
			});
			const deps = {
				repos,
				forge,
				directory: join(root, "ready"),
				projectsConfig: { root: join(root, "projects"), gitBinary: "git" },
				creationDirectory: join(root, "creation"),
				spawn,
			};
			const preview = previewNewProject({ owner: "owner", name: "app", template: "go-react" });
			await expect(createNewProject(deps, preview.request, "wrong")).rejects.toThrow("Confirm");
			expect(creates).toBe(0);
			const first = await createNewProject(deps, preview.request, preview.confirmation);
			const again = await createNewProject(deps, preview.request, preview.confirmation);
			expect(first.created).toBe(true);
			expect(first.ready).toBe(false);
			expect(again.project.id).toBe(first.project.id);
			expect(creates).toBe(1);
			expect(await Bun.file(join(first.project.localPath, "go.mod")).exists()).toBe(true);
			expect(await Bun.file(join(first.project.localPath, ".mulch")).exists()).toBe(false);
		} finally {
			await db.close();
		}
	});
});
