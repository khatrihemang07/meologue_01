ALTER TABLE `entries` ADD `updated_at` text;--> statement-breakpoint
UPDATE `entries` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `updated_at` text;--> statement-breakpoint
UPDATE `tasks` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `updated_at` text;--> statement-breakpoint
UPDATE `projects` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
ALTER TABLE `sections` ADD `updated_at` text;--> statement-breakpoint
UPDATE `sections` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `updated_at` text;--> statement-breakpoint
UPDATE `labels` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
ALTER TABLE `filters` ADD `updated_at` text;--> statement-breakpoint
UPDATE `filters` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `updated_at` text;--> statement-breakpoint
UPDATE `comments` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
