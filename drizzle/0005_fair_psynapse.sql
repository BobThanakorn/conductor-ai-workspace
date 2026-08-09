CREATE TABLE `mcp_registry_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`server_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`detail_code` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_registry_events_event_id_idx` ON `mcp_registry_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `mcp_registry_events_workspace_idx` ON `mcp_registry_events` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`workspace_id` text NOT NULL,
	`server_id` text NOT NULL,
	`allowlist_id` text NOT NULL,
	`label` text NOT NULL,
	`status` text DEFAULT 'registered' NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`last_error_code` text,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `server_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_servers_workspace_status_idx` ON `mcp_servers` (`workspace_id`,`status`,`enabled`);
--> statement-breakpoint
CREATE TRIGGER `mcp_registry_events_no_update`
BEFORE UPDATE ON `mcp_registry_events`
BEGIN SELECT RAISE(ABORT, 'mcp_registry_events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `mcp_registry_events_no_delete`
BEFORE DELETE ON `mcp_registry_events`
BEGIN SELECT RAISE(ABORT, 'mcp_registry_events are append-only'); END;
