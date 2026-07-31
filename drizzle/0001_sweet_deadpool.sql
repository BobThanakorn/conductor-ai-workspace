CREATE TABLE `agent_run_audit` (
	`run_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`engine` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`token_usage_json` text DEFAULT '{}' NOT NULL,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`audit_log_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_run_audit_workspace_idx` ON `agent_run_audit` (`workspace_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `agent_run_audit_no_update`
BEFORE UPDATE ON `agent_run_audit`
BEGIN SELECT RAISE(ABORT, 'agent_run_audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `agent_run_audit_no_delete`
BEFORE DELETE ON `agent_run_audit`
BEGIN SELECT RAISE(ABORT, 'agent_run_audit is append-only'); END;
