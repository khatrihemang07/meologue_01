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
 * Both Restore and Merge need this, for opposite reasons, and neither gets it
 * for free. Restore replaces `kv` from the Backup's own contents, so a Backup
 * taken before the migration existed restores a Device that believes it has
 * already migrated — over rows that have not been. Merge excludes `kv`
 * outright (`MERGE_EXCLUDED_TABLES`), so a marker set before the Merge simply
 * survives it, while the rows folded in may predate the migration entirely.
 * Different mechanisms, same outcome: un-migrated rows behind a marker
 * claiming otherwise, and nothing left to notice.
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
