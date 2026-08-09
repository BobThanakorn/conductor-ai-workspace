ALTER TABLE `tasks` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `lease_expires_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `checkpoint_id` text;--> statement-breakpoint
CREATE INDEX `tasks_workspace_lease_idx` ON `tasks` (`workspace_id`,`lease_expires_at`);