CREATE TABLE `handoff_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`decision` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`evidence_digest` text NOT NULL,
	`human_approved` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `handoff_reviews_handoff_idx` ON `handoff_reviews` (`handoff_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`from_role` text NOT NULL,
	`to_role` text NOT NULL,
	`submitted_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`context_json` text NOT NULL,
	`evidence_json` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`created_at` text NOT NULL,
	`accepted_by` text,
	`accepted_at` text,
	`published_by` text,
	`published_at` text,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `handoffs_workspace_task_idx` ON `handoffs` (`workspace_id`,`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `handoffs_status_idx` ON `handoffs` (`workspace_id`,`status`);
--> statement-breakpoint
CREATE TRIGGER `handoff_reviews_no_update`
BEFORE UPDATE ON `handoff_reviews`
BEGIN SELECT RAISE(ABORT, 'handoff_reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `handoff_reviews_no_delete`
BEFORE DELETE ON `handoff_reviews`
BEGIN SELECT RAISE(ABORT, 'handoff_reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `handoffs_immutable_payload`
BEFORE UPDATE OF `workspace_id`, `task_id`, `from_role`, `to_role`, `submitted_by`, `context_json`, `evidence_json`, `evidence_digest`, `created_at` ON `handoffs`
BEGIN SELECT RAISE(ABORT, 'handoff identity, context, and evidence are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `handoffs_no_delete`
BEFORE DELETE ON `handoffs`
BEGIN SELECT RAISE(ABORT, 'handoffs cannot be deleted'); END;
