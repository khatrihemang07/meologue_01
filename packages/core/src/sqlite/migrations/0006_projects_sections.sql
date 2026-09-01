CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text NOT NULL,
	`favourite` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`parent_id` text,
	`description` text,
	`order_key` text NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_order_key_id_idx` ON `projects` (`order_key`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_parent_id_idx` ON `projects` (`parent_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`order_key` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`seq` integer,
	`synced_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sections_project_id_order_key_id_idx` ON `sections` (`project_id`,`order_key`,`id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `project_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `section_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_project_id_idx` ON `tasks` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_parent_id_idx` ON `tasks` (`parent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_section_id_idx` ON `tasks` (`section_id`);
