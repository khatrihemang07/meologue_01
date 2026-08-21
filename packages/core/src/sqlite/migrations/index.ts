import initial from "./0000_initial.sql?raw";
import entryDeletedAt from "./0001_entry_deleted_at.sql?raw";
import entriesSearchIndex from "./entries_search_index.sql?raw";

export interface Migration {
  version: number;
  sql: string;
}

/**
 * Generated SQL (drizzle-kit, from ../schema.ts — never hand-edited except
 * to add `IF NOT EXISTS`, or, for migration 3 below, to make its
 * non-idempotent `ALTER TABLE` safe at the statement level instead),
 * embedded at build time via Vite's `?raw` import rather than read from
 * disk at runtime: the migrator drizzle ships for this driver hard-imports
 * node:fs to do that, which can't run in a WebView (ADR 0007).
 *
 * Add a migration by running `drizzle-kit generate`, editing its DDL to be
 * safely re-runnable, and appending an entry here. `version` is the ledger
 * key (../migrator.ts) — never reuse or reorder one once committed. Most
 * migrations get that safety from `IF NOT EXISTS`, but that isn't
 * universally true any more: migration 3 (`0001_entry_deleted_at.sql`) is
 * an `ALTER TABLE ADD COLUMN`, which SQLite has no `IF NOT EXISTS` form
 * for, so its idempotence instead comes from ../migrator.ts treating a
 * `duplicate column name` error as success — see that file and ADR 0007's
 * amendment (ADR 0028) for why a transaction isn't available here either.
 *
 * `entries_search_index` is the one exception: an FTS5 virtual table isn't
 * representable in ../schema.ts, so drizzle-kit can neither generate nor
 * track it — it's hand-written SQL, not named with drizzle-kit's `NNNN_`
 * convention so a future real `generate` run can't collide with it, and
 * `meta/` is left describing only the tables schema.ts actually declares
 * (ADR 0014). Its second statement backfills Entries that existed before
 * this migration shipped; `WHERE id NOT IN (...)` is the guard that keeps
 * re-running it from duplicating index rows, since the runner wraps
 * nothing in a transaction and relies on every statement being safe to
 * re-run on its own.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: initial },
  { version: 2, sql: entriesSearchIndex },
  { version: 3, sql: entryDeletedAt },
];
