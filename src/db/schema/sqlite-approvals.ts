import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
	ApprovedPlanSnapshot,
	PlanEffectKind,
	PlanEffectState,
	TaskAttemptKind,
} from "../../core/plan-approval.ts";
import { TABLE_NAMES } from "./columns.ts";
import { planRuns, projects } from "./sqlite.ts";
export const planApprovals = sqliteTable(TABLE_NAMES.planApprovals, {
	id: text("id").primaryKey(),
	commandKey: text("command_key").notNull().unique(),
	digest: text("digest").notNull(),
	projectId: text("project_id")
		.notNull()
		.references(() => projects.id, { onDelete: "cascade" }),
	snapshot: text("snapshot", { mode: "json" }).$type<ApprovedPlanSnapshot>().notNull(),
	revision: integer("revision").notNull(),
	supersedesId: text("supersedes_id"),
	planRunId: text("plan_run_id"),
	decision: text("decision").notNull(),
	createdAt: text("created_at").notNull(),
});
export const planEffects = sqliteTable(TABLE_NAMES.planEffects, {
	identity: text("identity").primaryKey(),
	planRunId: text("plan_run_id")
		.notNull()
		.references(() => planRuns.id, { onDelete: "cascade" }),
	seq: integer("seq").notNull(),
	kind: text("kind").$type<PlanEffectKind>().notNull(),
	state: text("state").$type<PlanEffectState>().notNull(),
	target: text("target").notNull(),
	result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
	reason: text("reason"),
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
});

export const planTaskAttempts = sqliteTable(TABLE_NAMES.planTaskAttempts, {
	key: text("key").primaryKey(),
	planRunId: text("plan_run_id")
		.notNull()
		.references(() => planRuns.id, { onDelete: "cascade" }),
	seq: integer("seq").notNull(),
	kind: text("kind").$type<TaskAttemptKind>().notNull(),
	runId: text("run_id"),
	createdAt: text("created_at").notNull(),
	endedAt: text("ended_at"),
});
