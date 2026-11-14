import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approvedFixture } from "../plan-runs/approval-test-helpers.ts";
import { syncApprovedSeeds } from "./approved-plan-store.ts";

describe("factory-owned Seeds mirror", () => {
	test("stores approved descriptions and criteria, then rebuilds progress after reopening the database", async () => {
		const f = await approvedFixture();
		try {
			const root = join(f.root, "seeds", f.approval.id, ".seeds");
			const issues = (await readFile(join(root, "issues.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(issues).toHaveLength(2);
			expect(issues[0]).toMatchObject({
				title: "One",
				description: "First task",
				labels: ["ready-for-agent"],
			});
			await f.repos.planRuns.updateChild({
				planRunId: f.planRun.id,
				seq: 1,
				patch: { state: "skipped" },
			});
			await f.reopen();
			await syncApprovedSeeds(
				f.approval,
				await f.repos.planRuns.listChildren(f.planRun.id),
				f.root,
			);
			const updated = JSON.parse(
				(await readFile(join(root, "issues.jsonl"), "utf8")).split("\n")[0] ?? "{}",
			);
			expect(updated.status).toBe("closed");
			expect(updated.extensions.factory.acceptance).toEqual(["First check"]);
			const sd = Bun.which("sd");
			if (sd) {
				const proc = Bun.spawn([sd, "list", "--json"], {
					cwd: join(root, ".."),
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = await new Response(proc.stdout).text();
				const error = await new Response(proc.stderr).text();
				expect({ code: await proc.exited, error }).toEqual({ code: 0, error: "" });
				expect(output).toContain("Second task");
			}
		} finally {
			await f.dispose();
		}
	});
	test("fails an unwritable mirror without deleting saved approval or mutating a project repository", async () => {
		const f = await approvedFixture();
		try {
			const file = join(f.root, "not-a-directory");
			await writeFile(file, "owned");
			await expect(syncApprovedSeeds(f.approval, [], file)).rejects.toThrow();
			expect((await f.repos.planApprovals.require(f.approval.id)).digest).toBe(f.approval.digest);
		} finally {
			await f.dispose();
		}
	});
});
