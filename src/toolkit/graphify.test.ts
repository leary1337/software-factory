import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitFixture } from "../workspace/git/test-fixture.ts";
import { graphifyEnvironment, graphVersion, runGraphCommand } from "./graphify.ts";

describe("local code graph", () => {
	test("disables every model backend and does not forward credentials", () => {
		const env = graphifyEnvironment({
			PATH: "/bin",
			HOME: "/home",
			OPENAI_API_KEY: "secret",
			ANTHROPIC_API_KEY: "secret",
			GRAPHIFY_BACKEND: "claude-code",
		});
		expect(env.GRAPHIFY_BACKEND).toBe("none");
		expect(env.GRAPHIFY_NO_AUTO_REFRESH).toBe("1");
		expect(env).not.toHaveProperty("OPENAI_API_KEY");
		expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
	});
	test("detects uncommitted code changes without treating the old index as current", async () => {
		const fixture = await createGitFixture({ prefix: "toolkit-graph-", initCommit: "base" });
		try {
			await writeFile(join(fixture.path, "example.ts"), "export const value = 1;");
			const before = await graphVersion(fixture.path);
			await writeFile(join(fixture.path, "example.ts"), "export const value = 2;");
			const after = await graphVersion(fixture.path);
			expect(before.revision).toBe(after.revision);
			expect(before.fingerprint).not.toBe(after.fingerprint);
		} finally {
			await fixture.cleanup();
		}
	});
	test("bounds a hung graph subprocess", async () => {
		await expect(runGraphCommand(["/bin/sh", "-c", "sleep 20"], process.cwd(), 30)).rejects.toThrow(
			"Local graph command failed",
		);
	});
});
