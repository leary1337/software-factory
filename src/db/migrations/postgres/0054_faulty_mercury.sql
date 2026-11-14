CREATE TABLE "project_settings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_settings" ENABLE ROW LEVEL SECURITY;
