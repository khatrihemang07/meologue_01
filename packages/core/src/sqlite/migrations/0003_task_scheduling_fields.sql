ALTER TABLE `tasks` ADD `date` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deadline` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `duration` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` integer DEFAULT 1 NOT NULL;