CREATE TABLE `mcp_policy_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`risk` text NOT NULL,
	`previous_decision` text NOT NULL,
	`decision` text NOT NULL,
	`previous_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_policy_events_event_id_idx` ON `mcp_policy_events` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_policy_events_idempotency_idx` ON `mcp_policy_events` (`workspace_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_policy_events_revision_idx` ON `mcp_policy_events` (`workspace_id`,`revision`);--> statement-breakpoint
CREATE INDEX `mcp_policy_events_workspace_idx` ON `mcp_policy_events` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `mcp_policy_state` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `mcp_tool_policies` (
	`workspace_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`decision` text DEFAULT 'inherit' NOT NULL,
	`risk` text NOT NULL,
	`requires_approval` integer DEFAULT 0 NOT NULL,
	`revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `scope_type`, `scope_id`, `server_id`, `tool_name`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_tool_policies_workspace_idx` ON `mcp_tool_policies` (`workspace_id`,`server_id`,`tool_name`);--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `mcp_policy_events_no_update`
BEFORE UPDATE ON `mcp_policy_events`
BEGIN SELECT RAISE(ABORT, 'mcp_policy_events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `mcp_policy_events_no_delete`
BEFORE DELETE ON `mcp_policy_events`
BEGIN SELECT RAISE(ABORT, 'mcp_policy_events are append-only'); END;
