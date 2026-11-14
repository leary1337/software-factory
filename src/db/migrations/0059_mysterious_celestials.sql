CREATE TABLE `project_settings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
