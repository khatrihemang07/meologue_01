import type { SqliteDriver } from "../sqlite/driver";
import { SOFT_BREAK_MIGRATION_KEY } from "../sqlite/schema";
import { quoteIdent } from "./dump";

/** The key-value table both Restore and Merge have to reach into by name. */
export const KV_TABLE = "kv";

/**
 * Clears the marker that says this Device has already run the soft-break body
 * migration (ADR 0067), so the next store open runs it again over whatever
 * rows have just arrived.
 *
 * Both Restore and Merge need this, by different routes, and neither gets it
 * for free.
 *
 * Restore does not wipe `kv`: `restoreTable` only upserts the rows the Backup
 * file actually names, leaving this Device's other `kv` rows alone. A Backup
 * taken before this migration existed never names `SOFT_BREAK_MIGRATION_KEY`
 * at all, so a Device that had already migrated keeps its marker across the
 * Restore — now sitting over freshly restored bodies that predate the
 * migration entirely.
 *
 * Merge gets there the other way: `kv` is excluded outright
 * (`MERGE_EXCLUDED_TABLES`), so the marker survives by construction, while the
 * rows folded in may come from a Device that never ran the migration.
 *
 * Different mechanisms, same outcome: un-migrated rows behind a marker
 * claiming otherwise, and nothing left to notice. Re-arming unconditionally
 * costs at most one redundant re-scan, because the migration's own per-row
 * `updatedAt` guard — not this marker — is what decides whether any given row
 * is actually rewritten. That is a far cheaper mistake than leaving a restored
 * History silently unmigrated forever.
 *
 * It lives here rather than in either caller because it existed twice, once
 * per file, and the two copies had already drifted — one named the table
 * through a local `KV_TABLE` constant, the other spelled `"kv"` inline. That
 * is the cheapest possible version of the bug where a table is renamed and
 * only one of the two follows.
 */
export async function rearmSoftBreakMigration(driver: SqliteDriver): Promise<void> {
  await driver.execute(
    `DELETE FROM ${quoteIdent(KV_TABLE)} WHERE key = ?`,
    [SOFT_BREAK_MIGRATION_KEY],
    "run",
  );
}
