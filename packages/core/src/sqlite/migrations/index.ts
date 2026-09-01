import initial from "./0000_initial.sql?raw";
import entryDeletedAt from "./0001_entry_deleted_at.sql?raw";
import tasksTable from "./0002_tasks_table.sql?raw";
import taskSchedulingFields from "./0003_task_scheduling_fields.sql?raw";
import labelsTable from "./0004_labels_table.sql?raw";
import taskRecurrenceString from "./0005_task_recurrence_string.sql?raw";
import projectsSections from "./0006_projects_sections.sql?raw";
import entriesSearchIndex from "./entries_search_index.sql?raw";
import tasksSearchIndex from "./tasks_search_index.sql?raw";

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
 * re-run on its own. `tasks_search_index` (version 5, issue #168) is the
 * same exception for the same reason, mirrored exactly, including its own
 * `WHERE id NOT IN (...)` backfill guard — a second FTS5 table for a
 * second root noun (ADR 0047), not a reason to invent a second technique.
 *
 * `0002_tasks_table` (version 4, issue #168) is a real `drizzle-kit
 * generate` output — the `tasks` table is representable in ../schema.ts,
 * unlike the FTS5 tables above — hand-edited only to add `IF NOT EXISTS`
 * to its `CREATE TABLE` and `CREATE INDEX`, the same treatment migration 1
 * got.
 *
 * `0003_task_scheduling_fields` (version 6, issue #169) is four more
 * `ALTER TABLE ADD COLUMN` statements, unedited `drizzle-kit generate`
 * output — no hand-editing needed this time, because `ADD COLUMN` already
 * gets its idempotence from ../migrator.ts's `duplicate column name` swallow
 * rather than from `IF NOT EXISTS` (SQLite has no such form for it), the
 * same way migration 3 does. Deliberately relying on that swallow again
 * here rather than reinventing a guard: a process that dies after adding,
 * say, `date` and `deadline` but before `duration` and `priority` re-runs
 * this migration from its first statement on restart (migrate() reruns a
 * migration wholesale until every one of its statements has landed and the
 * ledger row is written — see ../migrator.ts), and the two already-added
 * columns throw exactly the swallowed error while the remaining two land
 * for real. Versions 4 and 5 were already spent by issue #168, which is why
 * this is 6.
 *
 * `0004_labels_table` (version 8, issue #170's Labels half) is a real
 * `drizzle-kit generate`-shaped migration, hand-written rather than
 * actually run through `drizzle-kit generate`: issue #170 split into a
 * parser agent and a recurrence-engine agent working the same tree at
 * the same time, the latter owning migration version 7 (below) and its
 * own `ALTER TABLE tasks ADD date_string` — running `generate` here would
 * stamp a `meta/_journal.json` entry with no way to know whether the
 * sibling agent's own `generate` run already claimed that slot at the
 * same moment. Hand-writing the SQL and leaving `meta/` untouched avoids
 * that collision entirely; `meta/` staying behind schema.ts is exactly
 * the state `entries_search_index` and `tasks_search_index` already leave
 * it in indefinitely, for their own reason (see this comment's earlier
 * paragraph).
 *
 * **Do not "true `meta/` back up" with a `drizzle-kit generate` run.** An
 * earlier draft of this comment claimed such a run would produce no diff.
 * It was tried, once both halves of #170 had landed, and that is false:
 * `generate` diffs schema.ts against the last *snapshot* it wrote
 * (`0003`), not against the migrations actually registered below, so it
 * emits a fresh migration re-creating the `labels` table and re-adding
 * `label_ids` and `date_string` — a verbatim duplicate of versions 7 and
 * 8, numbered `0004_*` so it also collides with `0004_labels_table.sql`'s
 * own filename. Registering that would apply the same DDL twice; not
 * registering it leaves a `_journal.json` entry naming a migration this
 * file never runs. Both are worse than the drift.
 *
 * `meta/` is drizzle-kit's own bookkeeping and nothing at runtime reads
 * it — ../migrator.ts's ledger table is the only thing that decides what
 * has been applied, and MIGRATIONS below is the only list it walks. The
 * drift costs a future `generate` run its usefulness for these tables,
 * which is a real cost and is why it is written down here rather than
 * left to be rediscovered.
 * This file follows migration 6's own template: `CREATE TABLE IF NOT
 * EXISTS` for the new `labels` table (representable, so idempotent the
 * ordinary way) and an `ALTER TABLE tasks ADD label_ids` that leans on
 * the `duplicate column name` swallow (../migrator.ts) the same way
 * migration 6's four `ADD COLUMN` statements do.
 *
 * `0005_task_recurrence_string` (version 7, issue #170's recurrence-
 * engine half) is the sibling migration `0004_labels_table`'s own doc
 * comment above describes: a single `ALTER TABLE tasks ADD date_string`,
 * hand-written for the identical reason (a concurrent `generate` run
 * against a `meta/` neither agent could see the other's changes to would
 * risk numbering the same journal slot twice), leaning on the same
 * `duplicate column name` swallow. It's sequenced *before* version 8
 * here even though it was written after — version numbers are the
 * ledger key (../migrator.ts), not file-write order, and 7 was already
 * reserved for it before this file's own labels-only version 8 landed.
 *
 * `0006_projects_sections` (version 9, issue #171) adds two new,
 * representable-in-../schema.ts tables (`projects`, `sections`) and three
 * more `ALTER TABLE tasks ADD` columns (`project_id`, `section_id`,
 * `parent_id`), plus indexes on all of it. Hand-written rather than run
 * through `drizzle-kit generate`, for the identical reason every migration
 * since `0004_labels_table` has been: `generate` still diffs against the
 * stale `0003` snapshot (this comment's own "**Do not 'true `meta/` back
 * up`'**" paragraph above hasn't changed since it was written), so a real
 * `generate` run today would re-emit versions 6-8's own DDL a second time
 * under a colliding `0004_*`/`0006_*` filename rather than emitting only
 * what's new here. `CREATE TABLE IF NOT EXISTS` covers the two new tables
 * (representable, idempotent the ordinary way, migration 4's own
 * template); the three `ADD COLUMN` statements lean on ../migrator.ts's
 * `duplicate column name` swallow, migration 6's template. All of this
 * migration's `CREATE INDEX` statements are `IF NOT EXISTS` for the same
 * reason every other index-creating statement in this file is.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: initial },
  { version: 2, sql: entriesSearchIndex },
  { version: 3, sql: entryDeletedAt },
  { version: 4, sql: tasksTable },
  { version: 5, sql: tasksSearchIndex },
  { version: 6, sql: taskSchedulingFields },
  { version: 7, sql: taskRecurrenceString },
  { version: 8, sql: labelsTable },
  { version: 9, sql: projectsSections },
];
