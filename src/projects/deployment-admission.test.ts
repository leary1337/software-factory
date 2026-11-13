import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeploymentAdmission } from "./deployment-admission.ts";

test("deployment admission preserves intent across restart outside the repository", async () => {
	const directory = await mkdtemp(join(tmpdir(), "factory-admission-"));
	try {
		const first = createDeploymentAdmission({ directory });
		const intent = {
			ownerRunId: null,
			workflow: "deploy.yml",
			branch: "main",
			requestedAt: new Date().toISOString(),
			previousRunIds: [1],
		};
		await first.write("../../arbitrary-project-id", intent);
		const restarted = createDeploymentAdmission({ directory });
		expect(await restarted.read("../../arbitrary-project-id")).toEqual(intent);
		expect(await readdir(directory)).toHaveLength(1);
		expect((await readdir(directory))[0]).toMatch(/^[a-f0-9]{64}\.json$/);
		await restarted.clear("../../arbitrary-project-id");
		expect(await first.read("../../arbitrary-project-id")).toBeNull();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("deployment admission serializes callers and releases a failed request", async () => {
	const admission = createDeploymentAdmission();
	const order: number[] = [];
	let release: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = admission.withLock("project", async () => {
		order.push(1);
		await pending;
		throw new Error("failed");
	});
	const second = admission.withLock("project", async () => {
		order.push(2);
	});
	release?.();
	await expect(first).rejects.toThrow("failed");
	await second;
	expect(order).toEqual([1, 2]);
});
