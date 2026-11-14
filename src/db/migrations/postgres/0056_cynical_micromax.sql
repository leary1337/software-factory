CREATE TABLE "plan_task_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"plan_run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_task_attempts" ADD CONSTRAINT "plan_task_attempts_plan_run_id_plan_runs_id_fk" FOREIGN KEY ("plan_run_id") REFERENCES "public"."plan_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_task_attempts" ENABLE ROW LEVEL SECURITY;
