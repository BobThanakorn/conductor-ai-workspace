CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text,
	`idempotency_key` text NOT NULL,
	`mode` text NOT NULL,
	`model` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`output_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_workspace_idempotency_idx` ON `agent_runs` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_runs_task_idx` ON `agent_runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`action` text NOT NULL,
	`summary` text NOT NULL,
	`risk_level` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`action_digest` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`decided_by` text,
	`decision_note` text,
	`decision_event_id` text,
	`decision_idempotency_key` text,
	`decided_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvals_workspace_status_idx` ON `approvals` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `approvals_task_idx` ON `approvals` (`task_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`owner_token` text NOT NULL,
	`response_status` integer,
	`response_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`actor` text NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_events_event_id_idx` ON `task_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `task_events_workspace_sequence_idx` ON `task_events` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `task_events_task_sequence_idx` ON `task_events` (`task_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`risk_level` text DEFAULT 'R1' NOT NULL,
	`branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`actor` text DEFAULT 'Human + Agent' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`model` text,
	`created_by_idempotency_key` text NOT NULL,
	`last_transition_key` text,
	`cancellation_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_workspace_status_idx` ON `tasks` (`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_workspace_creation_key_idx` ON `tasks` (`workspace_id`,`created_by_idempotency_key`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repository_name` text NOT NULL,
	`repository_path` text NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`active_branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
