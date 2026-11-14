import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanApproval } from "../core/plan-approval.ts";
import { TrackerError } from "../core/wire.ts";
import type { PlanRunChildRow } from "../db/schema.ts";

/** Factory-owned Seeds projection: ordinary plan work never requires the owner's CLI. */
export async function syncApprovedSeeds(
	approval: PlanApproval,
	children: readonly PlanRunChildRow[] = [],
	root = process.env.WARREN_DATA_DIR ?? join(homedir(), ".warren", "data"),
): Promise<void> {
	if (approval.snapshot.taskSource !== "internal") return;
	const directory = join(root, "seeds", approval.id, ".seeds");
	const now = new Date().toISOString();
	const issues = approval.snapshot.tasks.map((task) => {
		const child = children.find((child) => child.seq === task.seq);
		const status =
			child?.state === "merged" || child?.state === "skipped"
				? "closed"
				: child?.runId
					? "in_progress"
					: task.initialStatus;
		return {
			id: task.id,
			title: task.title,
			description: task.description,
			status,
			type: "task",
			priority: 2,
			createdAt: approval.createdAt,
			updatedAt: now,
			blockedBy: task.dependsOn
				.map((seq) => approval.snapshot.tasks.find((dependency) => dependency.seq === seq)?.id)
				.filter(Boolean),
			labels: ["ready-for-agent"],
			plan_id: approval.id,
			plan_step_index: task.seq,
			extensions: {
				factory: {
					approvalId: approval.id,
					revision: approval.revision,
					acceptance: task.acceptance,
				},
			},
		};
	});
	const plan = {
		id: approval.id,
		seed: issues[0]?.id,
		template: "factory-approved",
		name: approval.snapshot.title,
		status:
			children.length > 0 && issues.every((issue) => issue.status === "closed")
				? "done"
				: approval.planRunId
					? "active"
					: "approved",
		revision: approval.revision,
		sections: {},
		children: issues.map((issue) => issue.id),
		createdAt: approval.createdAt,
		updatedAt: now,
	};
	try {
		await mkdir(directory, { recursive: true });
		for (const [file, body] of [
			["config.yaml", "project: factory\nversion: '1'\n"],
			["issues.jsonl", `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`],
			["plans.jsonl", `${JSON.stringify(plan)}\n`],
			["templates.jsonl", ""],
		]) {
			if (file === undefined || body === undefined) continue;
			const path = join(directory, file);
			const temporary = `${path}.${crypto.randomUUID()}.tmp`;
			await writeFile(temporary, body, { mode: 0o600 });
			await rename(temporary, path);
		}
	} catch (cause) {
		throw new TrackerError(
			"The factory could not save its internal task queue. Restore access to the data directory and retry; the approved plan is retained.",
			{ cause },
		);
	}
}
