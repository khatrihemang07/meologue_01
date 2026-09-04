CREATE TABLE IF NOT EXISTS `filters` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`query` text NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `filters_name_id_idx` ON `filters` (`name`,`id`);
