ALTER TABLE `tasks` ADD `day_order` text;--> statement-breakpoint
UPDATE `tasks` SET `day_order` = `order_key` WHERE `day_order` IS NULL;
