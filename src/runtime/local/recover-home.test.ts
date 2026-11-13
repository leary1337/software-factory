import { expect, test } from "bun:test";
import { recoverLocalHome } from "./recover-home.ts";

test("preserves a legacy workspace whose process ownership cannot be confirmed", async () => {
	await expect(
		recoverLocalHome({
			version: 1,
			runId: "old-run",
			sandboxId: "local-old-run",
			branch: "work",
			workspacePath: "/missing/work",
			homePath: "/missing/home",
			source: { kind: "private", branch: "work" },
			createdAt: new Date().toISOString(),
		}),
	).rejects.toThrow("predates process supervision");
});
