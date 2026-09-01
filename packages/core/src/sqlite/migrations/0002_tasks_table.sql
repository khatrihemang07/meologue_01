CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`content` text NOT NULL,
	`completed_at` text,
	`order_key` text NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_order_key_id_idx` ON `tasks` (`order_key`,`id`);
