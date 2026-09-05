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
 * 7. **Save a safety Backup before writing anything at all** (issue #204).
 *    `BEGIN`/`COMMIT`/`ROLLBACK` (below) is a real guarantee only on a
 *    single-connection driver — not on macOS's pooled `TauriSqliteDriver`
 *    (apps/web/src/platform/tauri-sqlite-driver.ts) — so an apply
 *    interrupted partway there can leave a Device holding neither its old
 *    contents nor the Backup's, which is the exact failure a Backup exists
 *    to prevent. `restoreFromBackup`'s `takeSafetyBackup` parameter is the
 *    guard: Core awaits it and refuses to call `BEGIN` — writes nothing —
 *    if it fails, so an interrupted Restore is always recoverable by
 *    reapplying the safety Backup it made of its own accord a moment
 *    before. See `restoreFromBackup`'s own doc comment for the full
 *    reasoning, including why this mitigates the gap rather than closing
 *    it.
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
  /** The safety Backup `takeSafetyBackup` (below) produced before this Restore wrote anything — named here too, not just in a toast, so anything downstream of a successful Restore can still point back at "and here's the copy of what this Device held before." */
  safetyBackupFileName: string;
}

export type RestoreOutcome = { ok: true; result: RestoreResult } | { ok: false; reason: string };

/**
 * What `takeSafetyBackup` (below) reports back — deliberately the same
 * two-case shape `RestoreOutcome` itself uses, rather than a boolean plus a
 * nullable string, so a caller building one out of `createBackup` +
 * `saveFile` (apps/web/src/components/settings/data-section.tsx) can
 * pattern-match it the same way this file's own callers already do.
 * `fileName` is required on the `ok: true` case, not optional: the whole
 * point of taking a safety Backup is to be able to name it in an error
 * message if the Restore that follows fails, so a caller that can't report
 * where it saved one hasn't actually satisfied this contract.
 */
export type SafetyBackupOutcome = { ok: true; fileName: string } | { ok: false; reason: string };

/**
 * Produces and durably saves a safety Backup of `driver`'s own database,
 * *before* `restoreFromBackup` writes anything (issue #204's `#7` in this
 * file's own header comment). `packages/core` is platform-free — no DOM,
 * no Node built-ins (see ../backup/backup-zip.ts's own header comment for
 * the identical posture applied to an ordinary Backup) — so it cannot
 * write a file to disk itself; this callback is the seam a caller supplies
 * to do that, exactly the way `restoreFromBackup`'s own `onProgress`
 * parameter is a seam rather than a `console.log` call. Unlike
 * `onProgress`, this one isn't optional: a Restore with nowhere to fall
 * back to if it's interrupted is precisely the situation issue #204 exists
 * to close, so `restoreFromBackup` has no "skip the safety Backup" mode to
 * accidentally leave enabled.
 */
export type TakeSafetyBackup = () => Promise<SafetyBackupOutcome>;

export interface RestoreOptions {
  driver: SqliteDriver;
  databaseSql: string;
  /** Awaited before a single mutating statement reaches `driver` — see `SafetyBackupOutcome`'s own doc comment and reason 7 in this file's header comment. */
  takeSafetyBackup: TakeSafetyBackup;
  onProgress?: (message: string) => void;
}

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
 * `options.takeSafetyBackup` runs first — before `parseBackupDatabase`'s
 * own structural check has even finished mattering, and, more to the
 * point, before a single `BEGIN` or mutating statement reaches `driver`.
 * If it throws, or resolves `{ ok: false }`, this function returns
 * `{ ok: false, reason }` of its own having called `driver.execute` for
 * nothing but the read-only parse above — no `BEGIN`, no write, nothing to
 * roll back. That ordering is enforced here, structurally, rather than
 * documented as something a caller has to remember to do first: a caller
 * that merely promised to call `createBackup` before `restoreFromBackup`
 * would be exactly the convention-not-structure hazard every other guard
 * in this file's own header comment exists to close instead (issue #204).
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
 * pooled Tauri driver today.
 *
 * **This is exactly the gap `takeSafetyBackup` mitigates, not closes**
 * (issue #204). It does not make `TauriSqliteDriver` transactional —
 * nothing short of `migrate()`'s per-statement-idempotent rewrite would —
 * and an apply interrupted partway on that driver can still leave rows
 * from both the old database and the new one sitting side by side. What
 * changes is that this is no longer unrecoverable: a faithful copy of the
 * pre-Restore database now always exists, durably saved, before that
 * partial state could ever be written. If the apply below then throws,
 * the error it propagates names the safety Backup's own file name (the
 * `catch` block just below) — "your data is safe, here's where" is the
 * entire point of having taken one. Narrowing macOS's transaction gap
 * itself, rather than working around it, is still future work belonging
 * to whoever next revisits `TauriSqliteDriver`.
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
export async function restoreFromBackup(options: RestoreOptions): Promise<RestoreOutcome> {
  const { driver, databaseSql, takeSafetyBackup, onProgress } = options;

  const parsed = await parseBackupDatabase(databaseSql, driver);
  if (!parsed.ok) {
    return parsed;
  }

  onProgress?.("Saving a safety Backup…");
  const safetyBackup = await takeSafetyBackup().catch(
    (error: unknown): SafetyBackupOutcome => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  if (!safetyBackup.ok) {
    return {
      ok: false,
      reason: `Safety Backup failed, so nothing was restored: ${safetyBackup.reason}`,
    };
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
    // Names the safety Backup rather than just the failure — an
    // unrecoverable half-state is only recoverable in practice if the
    // person looking at this message knows a copy exists and what it's
    // called (issue #204). `{ cause: error }` keeps the original failure
    // reachable for anything that logs it, without pushing it into the
    // message a reader actually sees.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Restore failed partway through: ${message} A safety Backup taken immediately before this Restore began was saved to ${safetyBackup.fileName} — restoring that file returns this Device to exactly the state it was in before this Restore started.`,
      { cause: error },
    );
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
      safetyBackupFileName: safetyBackup.fileName,
    },
  };
}
