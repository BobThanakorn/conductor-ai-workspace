CREATE TABLE `operations_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`event_type` text NOT NULL,
	`trace_id` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations_quota` (
	`workspace_id` text NOT NULL,
	`bucket` text NOT NULL,
	`window_start` text NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`workspace_id`, `bucket`, `window_start`)
);
--> statement-breakpoint
CREATE TRIGGER operations_audit_no_update
BEFORE UPDATE ON operations_audit
BEGIN SELECT RAISE(ABORT, 'operations_audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER operations_audit_no_delete
BEFORE DELETE ON operations_audit
BEGIN SELECT RAISE(ABORT, 'operations_audit is append-only'); END;
