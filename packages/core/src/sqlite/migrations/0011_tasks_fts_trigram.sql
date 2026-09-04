DROP TABLE IF EXISTS `tasks_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `tasks_fts` USING fts5(id UNINDEXED, content, tokenize='trigram case_sensitive 0 remove_diacritics 1');
--> statement-breakpoint
INSERT INTO `tasks_fts` (id, content)
SELECT id, content FROM tasks
WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM tasks_fts);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `task_descriptions_fts` USING fts5(id UNINDEXED, description, tokenize='trigram case_sensitive 0 remove_diacritics 1');
--> statement-breakpoint
INSERT INTO `task_descriptions_fts` (id, description)
SELECT id, description FROM tasks
WHERE deleted_at IS NULL AND description IS NOT NULL AND description != '' AND id NOT IN (SELECT id FROM task_descriptions_fts);
