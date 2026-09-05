import type { SqliteDriver } from "../sqlite/driver";
import { LEDGER_TABLE } from "../sqlite/migrator";
import { DEVICE_ID_KEY } from "../sqlite/schema";
import { SqliteEntryStore } from "../sqlite/sqlite-entry-store";
import { SqliteTaskStore } from "../sqlite/sqlite-task-store";
import { quoteIdent, tableColumns } from "./dump";
import { type ParsedTable, parseBackupDatabase } from "./parse";
import { rowContentUnchanged } from "./row-diff";

/**
 * Restore (issue #197, `CONTEXT.md`'s Restore entry): "this Device becomes
 * the Backup" — the honest, destructive counterpart to Backup (#195).
 * Everything below exists to make that true while still surviving the six
 * ways a naive "wipe and reload" would get it wrong, each named in the
 * ticket itself and each with its own guard here:
 *
 * 1. **Keep this Device's own identity.** A Device id names which Device a
 *    row was born on (`kv`'s own doc comment, ../sqlite/schema.ts); the
 *    Backup's `device_id` row is never applied — see `restoreTable`'s own
 *    guard for the `kv` table below.
 * 2. **Reset every Cursor and row-shape epoch to 0**, so the restored state
 *    reconciles against the Server honestly rather than assuming the
 *    Backup's own Device's Sync position (`resetCursorsAndEpochs` below).
 * 3. **Preserve `seq`/`synced_at` verbatim from the file** rather than
 *    blanking them — blanking would re-mark every row pending and re-push
 *    the whole database (`row-diff.ts`'s own header comment has the full
 *    reasoning, shared with Merge, #199).
 * 4. **Skip a row that hasn't actually changed** — not just cheaper, but
 *    what makes Restoring a Backup onto the Device that produced it close
 *    to a no-op (`rowContentUnchanged`, ./row-diff.ts).
 * 5. **Never touch `meologue_migrations`.** This Device's own ledger
 *    already reflects every migration *this build* has applied to the
 *    database Restore is writing into (../sqlite/open.ts always runs
 *    `migrate()` before handing a store back) — a Backup's ledger describes
 *    a different Device's migration history, or an earlier point in this
 *    one's, and blindly overwriting the live ledger with it could make
 *    `migrate()` believe a migration already reflected in the live schema
 *    still needs applying. `RESTORE_EXCLUDED_TABLES` below is the guard.
 * 6. **Rebuild the FTS5 indexes before reporting done** — see this file's
 *    own `restoreFromBackup` for why that runs after the transaction
 *    commits, not inside it.
 *
 * `database.sql`'s text is never handed to `driver.execute` directly —
 * ./parse.ts turns it into typed rows first, and every write below goes
 * through a parameterized statement built from those values, never through
 * string interpolation of anything the file itself contained (see
 * ./parse.ts's own header comment for the full "why").
 *
 * Takes no `deviceId` of its own to keep, unlike ./backup-zip.ts's
 * `createBackup`: reason 1 above is satisfied entirely by *never touching*
 * the target's existing `device_id` row (`restoreTable`'s own guard for the
 * `kv` table), so there is nothing for a caller to pass in — `driver` is
 * assumed to already be an opened store (../sqlite/open.ts's `open()`,
 * which always calls `ensureDeviceId()` before handing one back), the same
 * assumption ./backup-zip.ts's own `createBackup` already makes about the
 * driver it's given.
 */

export interface RestoreResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Every table the file named that this build's own schema doesn't have — carried straight through from ./parse.ts's `ParseBackupSuccess`. */
  skippedTables: string[];
  /** Every `table.column` the file named that this build's own schema doesn't have, for a table it does otherwise recognise. */
  skippedColumns: string[];
}

export type RestoreOutcome = { ok: true; result: RestoreResult } | { ok: false; reason: string };

/**
 * Tables a Backup's `database.sql` carries (`dump.ts`'s own header comment:
 * "the `kv` table and `meologue_migrations` ledger travel exactly like
 * every entity table") that Restore nonetheless never blindly overwrites
 * wholesale — `kv` gets row-level special-casing inside `restoreTable`
 * (the `device_id` row is skipped; every `*_cursor`/`*_row_shape_epoch` row
 * is reset afterward regardless of what the file said), and
 * `meologue_migrations` is excluded outright for reason 5 in this file's
 * own header comment.
 */
const RESTORE_EXCLUDED_TABLES: ReadonlySet<string> = new Set([LEDGER_TABLE]);

const KV_TABLE = "kv";
const KV_PRIMARY_KEY_COLUMN = "key";
const DEFAULT_PRIMARY_KEY_COLUMN = "id";

interface RestoreCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/** `kv`'s two families of Sync bookkeeping key — a bare `cursor`/`row_shape_epoch` for the Entry stream (../sqlite/schema.ts's own `CURSOR_KEY`/`ROW_SHAPE_EPOCH_KEY`) and a `<stream>_cursor`/`<stream>_row_shape_epoch` per every other stream (`sqlite-task-store.ts`'s `TASK_CURSOR_KEY` and its five siblings) — reset to `"0"` unconditionally after every table is restored, regardless of what value the Backup or the pre-Restore database held for it. Checked by suffix/exact-match against whatever keys `kv` actually holds post-restore, rather than a hardcoded list of every stream's key: a future stream's cursor key follows the identical `<name>_cursor` convention every existing one already does, so it's caught here with no edit needed, the same "read the convention, don't enumerate it" posture ../backup/dump.ts's own `listBackupTables` takes for tables. */
function isCursorOrEpochKey(key: string): boolean {
  return (
    key === "cursor" ||
    key === "row_shape_epoch" ||
    key.endsWith("_cursor") ||
    key.endsWith("_row_shape_epoch")
  );
}

/**
 * Restores one parsed table's rows into `driver`, in place: an upsert
 * (insert-or-update, skipping a row whose content columns already match —
 * `rowContentUnchanged`, ./row-diff.ts) for every row the Backup names,
 * then a delete for every row `driver`'s own table holds that the Backup
 * did *not* name — "this Device becomes the Backup" means a row that only
 * ever existed locally and was never pushed to the Server before this
 * Restore is genuinely gone afterward, which is exactly the destructive
 * half of Restore the settings-page.tsx confirmation exists to warn about
 * before anything is written.
 *
 * Reads the whole target table into memory once up front (one full-table
 * `SELECT`, matching `dump.ts`'s own posture at Backup time) rather than a
 * `SELECT ... WHERE id = ?` per row — at personal-log scale
 * (`docs/*`'s own "not enterprise scale" framing) this is simpler and
 * cheaper than N+1 lookups, and it's what lets the "everything not
 * mentioned gets deleted" pass run as a single, already-computed set
 * difference afterward instead of a second query.
 */
async function restoreTable(
  driver: SqliteDriver,
  table: ParsedTable,
  counts: RestoreCounts,
): Promise<void> {
  const primaryKeyColumn =
    table.name === KV_TABLE ? KV_PRIMARY_KEY_COLUMN : DEFAULT_PRIMARY_KEY_COLUMN;
  const columns = await tableColumns(driver, table.name);
  const columnNames = columns.map((column) => column.name);
  const selectSql = `SELECT ${columnNames.map(quoteIdent).join(", ")} FROM ${quoteIdent(table.name)}`;
  const { rows: existingRows } = await driver.execute(selectSql, [], "all");

  const existingByPrimaryKey = new Map<unknown, Record<string, unknown>>();
  for (const row of existingRows) {
    const record: Record<string, unknown> = {};
    (row as unknown[]).forEach((value, index) => {
      const columnName = columnNames[index];
      if (columnName !== undefined) {
        record[columnName] = value;
      }
    });
    existingByPrimaryKey.set(record[primaryKeyColumn], record);
  }

  const backupPrimaryKeys = new Set<unknown>();

  for (const row of table.rows) {
    const primaryKeyValue = row.values[primaryKeyColumn];
    if (table.name === KV_TABLE && primaryKeyValue === DEVICE_ID_KEY) {
      // Reason 1 in this file's own header comment: never adopt the
      // Backup's own device_id.
      continue;
    }

    backupPrimaryKeys.add(primaryKeyValue);
    const existing = existingByPrimaryKey.get(primaryKeyValue);
    if (rowContentUnchanged(existing, row.values)) {
      counts.unchanged += 1;
      continue;
    }

    const rowColumns = Object.keys(row.values);
    const placeholders = rowColumns.map(() => "?").join(", ");
    const updateAssignments = rowColumns
      .filter((column) => column !== primaryKeyColumn)
      .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
      .join(", ");
    const upsertSql =
      updateAssignments.length > 0
        ? `INSERT INTO ${quoteIdent(table.name)} (${rowColumns.map(quoteIdent).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(primaryKeyColumn)}) DO UPDATE SET ${updateAssignments}`
        : `INSERT INTO ${quoteIdent(table.name)} (${rowColumns.map(quoteIdent).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(primaryKeyColumn)}) DO NOTHING`;
    await driver.execute(
      upsertSql,
      rowColumns.map((column) => row.values[column]),
      "run",
    );

    if (existing === undefined) {
      counts.inserted += 1;
    } else {
      counts.updated += 1;
    }
  }

  if (table.name === KV_TABLE) {
    // kv is bookkeeping, not user data this Device "has" the way a Task or
    // an Entry does — a stream's cursor/epoch key this Backup's build
    // never had is left exactly as this Device's own migrate() already
    // set it (0, its own initial value), not deleted.
    return;
  }

  for (const primaryKeyValue of existingByPrimaryKey.keys()) {
    if (!backupPrimaryKeys.has(primaryKeyValue)) {
      await driver.execute(
        `DELETE FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(primaryKeyColumn)} = ?`,
        [primaryKeyValue],
        "run",
      );
    }
  }
}

/** Reason 2 in this file's own header comment — run once, after every table has been restored, so nothing written earlier in this same Restore can leave a nonzero Cursor behind it. */
async function resetCursorsAndEpochs(driver: SqliteDriver): Promise<void> {
  const { rows } = await driver.execute(`SELECT key FROM ${quoteIdent(KV_TABLE)}`, [], "all");
  for (const row of rows) {
    const key = (row as unknown[])[0] as string;
    if (isCursorOrEpochKey(key)) {
      await driver.execute(
        `UPDATE ${quoteIdent(KV_TABLE)} SET value = ? WHERE key = ?`,
        ["0", key],
        "run",
      );
    }
  }
}

/**
 * Applies a Backup's `database.sql` to `driver`'s own database, replacing
 * its contents with the Backup's (this file's own header comment has the
 * full reasoning for every guard below).
 *
 * Wrapped in `BEGIN`/`COMMIT`, with `ROLLBACK` on failure: a Restore that
 * dies halfway must not leave a half-replaced database (issue #197's own
 * framing). This is a real, if imperfect, safety net rather than a
 * guaranteed one on every target this app ships to: ADR 0007's
 * no-transaction posture exists because `TauriSqliteDriver`
 * (apps/web/src/platform/tauri-sqlite-driver.ts) runs statements through
 * `@tauri-apps/plugin-sql`'s own connection pool, which has no transaction
 * API — `BEGIN` and the statement after it may not even reach the same
 * connection (../sqlite/migrator.ts's own `migrate()` carries the
 * identical caveat, for the identical reason, and solves it a different
 * way: by making each individual statement idempotent instead of relying
 * on a transaction it can't get). Restore's own apply is a long sequence of
 * inserts, updates and deletes across many tables — recreating
 * `migrate()`'s per-statement-idempotent trick for all of it is a
 * materially bigger redesign than this ticket's own brief calls for, so
 * this function issues `BEGIN`/`COMMIT`/`ROLLBACK` as specified: a real
 * guarantee on the single-connection Node driver this package's own tests
 * run against, and on any other single-connection driver a future platform
 * adds, but — on the record, not silently — not a proven one on macOS's
 * pooled Tauri driver today. Narrowing that gap is future work belonging
 * to whoever next revisits `TauriSqliteDriver` itself, not something this
 * ticket's own scope stretches to cover.
 *
 * The FTS5 rebuild deliberately runs *after* `COMMIT`, not inside the same
 * transaction: `SqliteEntryStore`/`SqliteTaskStore`'s own `indexForSearch`
 * (../sqlite/sqlite-entry-store.ts, ../sqlite/sqlite-task-store.ts) already
 * assumes no transaction wraps it (ADR 0007) and is safe to call standalone
 * — reusing that existing, already-correct seam here is simpler than
 * threading a transaction through a store method that was never written to
 * expect one, and a rebuild that runs a moment after the data it reads has
 * already committed is no less correct than one squeezed inside the same
 * transaction would be.
 */
export async function restoreFromBackup(
  driver: SqliteDriver,
  databaseSql: string,
  onProgress?: (message: string) => void,
): Promise<RestoreOutcome> {
  const parsed = await parseBackupDatabase(databaseSql, driver);
  if (!parsed.ok) {
    return parsed;
  }

  const counts: RestoreCounts = { inserted: 0, updated: 0, unchanged: 0 };

  await driver.execute("BEGIN", [], "run");
  try {
    for (const table of parsed.tables) {
      if (RESTORE_EXCLUDED_TABLES.has(table.name)) {
        continue;
      }
      onProgress?.(`Restoring ${table.name}…`);
      await restoreTable(driver, table, counts);
    }
    onProgress?.("Resetting Sync state…");
    await resetCursorsAndEpochs(driver);
    await driver.execute("COMMIT", [], "run");
  } catch (error) {
    await driver.execute("ROLLBACK", [], "run").catch(() => {
      // Best-effort: if the connection is already gone, there is nothing
      // left to roll back on it, and the original `error` below is the one
      // worth surfacing.
    });
    throw error;
  }

  onProgress?.("Rebuilding search…");
  const entryStore = new SqliteEntryStore(driver);
  const taskStore = new SqliteTaskStore(driver);
  await entryStore.rebuildSearchIndex((done, total) =>
    onProgress?.(`Rebuilding search: Entries ${done}/${total}`),
  );
  await taskStore.rebuildSearchIndex((done, total) =>
    onProgress?.(`Rebuilding search: Tasks ${done}/${total}`),
  );

  return {
    ok: true,
    result: {
      ...counts,
      skippedTables: parsed.skippedTables,
      skippedColumns: parsed.skippedColumns,
    },
  };
}
