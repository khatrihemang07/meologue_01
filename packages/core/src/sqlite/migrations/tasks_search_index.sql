CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');
--> statement-breakpoint
INSERT INTO tasks_fts (id, content)
SELECT id, content FROM tasks
WHERE id NOT IN (SELECT id FROM tasks_fts);
