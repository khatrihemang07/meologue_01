CREATE TABLE IF NOT EXISTS `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`task_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `comments_task_id_created_at_id_idx` ON `comments` (`task_id`,`created_at`,`id`);
