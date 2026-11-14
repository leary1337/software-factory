CREATE TABLE `plan_task_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`plan_run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`plan_run_id`) REFERENCES `plan_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
