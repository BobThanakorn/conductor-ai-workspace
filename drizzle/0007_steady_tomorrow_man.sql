CREATE TABLE `automation_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_events_id_idx` ON `automation_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `automation_events_run_idx` ON `automation_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `automation_profiles` (
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `owner_id`, `kind`, `id`, `version`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`task_id` text,
	`lease_owner` text,
	`lease_expires_at` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_idempotency_idx` ON `automation_runs` (`automation_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `automation_runs_queue_idx` ON `automation_runs` (`workspace_id`,`owner_id`,`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `automation_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_snapshots_run_idx` ON `automation_snapshots` (`run_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`trigger_json` text NOT NULL,
	`agent_profile_id` text NOT NULL,
	`agent_profile_version` integer NOT NULL,
	`skill_profile_id` text NOT NULL,
	`skill_profile_version` integer NOT NULL,
	`next_run_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `automations_due_idx` ON `automations` (`workspace_id`,`owner_id`,`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TRIGGER `automation_events_no_update` BEFORE UPDATE ON `automation_events` BEGIN SELECT RAISE(ABORT, 'automation_events are append-only'); END;--> statement-breakpoint
CREATE TRIGGER `automation_events_no_delete` BEFORE DELETE ON `automation_events` BEGIN SELECT RAISE(ABORT, 'automation_events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `automation_profiles_no_update` BEFORE UPDATE ON `automation_profiles` BEGIN SELECT RAISE(ABORT, 'automation_profiles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `automation_profiles_no_delete` BEFORE DELETE ON `automation_profiles` BEGIN SELECT RAISE(ABORT, 'automation_profiles are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `automation_snapshots_no_update` BEFORE UPDATE ON `automation_snapshots` BEGIN SELECT RAISE(ABORT, 'automation_snapshots are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `automation_snapshots_no_delete` BEFORE DELETE ON `automation_snapshots` BEGIN SELECT RAISE(ABORT, 'automation_snapshots are immutable'); END;
