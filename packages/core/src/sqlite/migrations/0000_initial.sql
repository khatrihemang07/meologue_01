CREATE TABLE IF NOT EXISTS `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `entries_created_at_id_idx` ON `entries` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
