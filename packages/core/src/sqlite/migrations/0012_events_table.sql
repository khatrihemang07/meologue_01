CREATE TABLE IF NOT EXISTS `events` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`event_type` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`task_id` text,
	`project_id` text,
	`occurred_at` text NOT NULL,
	`extra` text,
	`seq` integer,
	`synced_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_task_id_occurred_at_id_idx` ON `events` (`task_id`,`occurred_at`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_project_id_occurred_at_id_idx` ON `events` (`project_id`,`occurred_at`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `events_occurred_at_id_idx` ON `events` (`occurred_at`,`id`);
