CREATE TABLE `plan_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`command_key` text NOT NULL,
	`digest` text NOT NULL,
	`project_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`revision` integer NOT NULL,
	`supersedes_id` text,
	`plan_run_id` text,
	`decision` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_approvals_command_key_unique` ON `plan_approvals` (`command_key`);--> statement-breakpoint
CREATE TABLE `plan_effects` (
	`identity` text PRIMARY KEY NOT NULL,
	`plan_run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`target` text NOT NULL,
	`result` text,
	`reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plan_run_id`) REFERENCES `plan_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
