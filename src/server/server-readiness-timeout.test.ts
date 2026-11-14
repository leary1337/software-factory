import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("readiness request lifetime", () => {
	test("returns a long authenticated check while ordinary requests retain the idle limit", async () => {
		// Bun's socket timer differs under bun:test: exercise the real server in a child.
		const child = Bun.spawn(
			[
				process.execPath,
				"--env-file=/dev/null",
				join(import.meta.dir, "fixtures/readiness-timeout.ts"),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH, WARREN_CODEX_BIN: "/missing-fixture-codex" },
			},
		);
		const deadline = setTimeout(() => child.kill(), 15000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const result = JSON.parse(stdout) as {
				denied: number;
				checks: number;
				readiness: {
					status: string;
					value: { status: number; body: { stale: boolean; checkedAt: string } };
				};
				ordinary: string;
				ordinaryError: string;
			};
			expect(result.denied).toBe(401);
			expect(result.checks).toBe(1);
			expect(result.readiness.status).toBe("fulfilled");
			expect(result.readiness.value.status).toBe(200);
			expect(result.readiness.value.body.stale).toBe(false);
			expect(result.readiness.value.body.checkedAt).toBeString();
			expect(result.ordinary).toBe("rejected");
			expect(result.ordinaryError).toContain("socket connection was closed");
		} finally {
			clearTimeout(deadline);
			child.kill();
		}
	}, 20000);
});
