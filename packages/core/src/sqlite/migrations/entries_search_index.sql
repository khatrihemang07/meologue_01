CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, body, tokenize='unicode61');
--> statement-breakpoint
INSERT INTO entries_fts (id, body)
SELECT id, body FROM entries
WHERE id NOT IN (SELECT id FROM entries_fts);
