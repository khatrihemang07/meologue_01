CREATE TABLE IF NOT EXISTS `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `labels_name_id_idx` ON `labels` (`name`,`id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `label_ids` text DEFAULT '[]' NOT NULL;
