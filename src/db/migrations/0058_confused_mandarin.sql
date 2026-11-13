ALTER TABLE `dispatch_context` DROP COLUMN `cap_source`;--> statement-breakpoint
ALTER TABLE `dispatch_context` DROP COLUMN `max_cost_usd`;--> statement-breakpoint
ALTER TABLE `plan_runs` DROP COLUMN `max_cost_usd`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `cost_usd`;--> statement-breakpoint
ALTER TABLE `runs` DROP COLUMN `cost_basis`;