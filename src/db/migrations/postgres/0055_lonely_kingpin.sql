CREATE TABLE "plan_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"command_key" text NOT NULL,
	"digest" text NOT NULL,
	"project_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"supersedes_id" text,
	"plan_run_id" text,
	"decision" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "plan_approvals_command_key_unique" UNIQUE("command_key")
);
--> statement-breakpoint
CREATE TABLE "plan_effects" (
	"identity" text PRIMARY KEY NOT NULL,
	"plan_run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"target" text NOT NULL,
	"result" jsonb,
	"reason" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_approvals" ADD CONSTRAINT "plan_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_effects" ADD CONSTRAINT "plan_effects_plan_run_id_plan_runs_id_fk" FOREIGN KEY ("plan_run_id") REFERENCES "public"."plan_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_effects" ENABLE ROW LEVEL SECURITY;
