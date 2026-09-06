import type { SqliteDriver } from "../sqlite/driver";
import { LEDGER_TABLE } from "../sqlite/migrator";
import { SqliteEntryStore } from "../sqlite/sqlite-entry-store";
import { SqliteTaskStore } from "../sqlite/sqlite-task-store";
import { quoteIdent, tableColumns } from "./dump";
import { type ParsedTable, parseBackupDatabase } from "./parse";
import type { SafetyBackupOutcome, TakeSafetyBackup } from "./restore";
import { rowContentUnchanged } from "./row-diff";

/**
 * Merge (issue #199, CONTEXT.md's Merge entry): folds another Device's
 * Backup into this one without discarding what this Device already holds
 * — where ./restore.ts's `restoreFromBackup` makes "this Device becomes
 * the Backup" true, this file makes "this Device gains what the Backup
 * has and it didn't" true instead, id by id:
 *
 * - a row only the Backup names is inserted;
 * - a row only this Device holds is left completely alone (never even
 *   read past the initial `SELECT`, exactly as ./restore.ts's own
 *   `restoreTable` already reads a table once up front);
 * - a row both hold resolves by whichever `updated_at` (issue #196) is
 *   greater — equal does nothing, and there is deliberately no
 *   clock-skew guard beyond that (CONTEXT.md's Merge entry, this
 *   ticket's own brief);
 * - content-identical rows are skipped outright regardless of what either
 *   side's `updated_at` says (`rowContentUnchanged`, ./row-diff.ts —
 *   built for exactly this reuse, see that file's own header comment),
 *   which is what keeps a Merge between two Devices with mostly-shared
 *   history from re-marking thousands of untouched rows pending (ADR
 *   0059's own framing of the failure this guards against); and
 * - a tombstone (`deleted_at`) is terminal on either side — mirroring
 *   `server/src/sync.rs`'s own `where <t>.deleted_at is null` guard, but
 *   adapted for a comparison Sync itself never makes: this Device's own
 *   existing tombstone can never be undone by an incoming row, no matter
 *   how much greater that row's `updated_at` claims to be (this is
 *   exactly the resurrection a fast Backup clock could otherwise cause,
 *   the concrete cost the "no clock-skew guard" decision above accepts
 *   everywhere *except* here), and an incoming tombstone always applies
 *   over a non-deleted local row, ahead of the ordinary `updated_at`
 *   comparison.
 *
 * `events` (ADR 0056) has no `updated_at` and no `deleted_at` — it is
 * append-only by design, so Merge only ever inserts one it doesn't
 * already have and never overwrites an existing one; this is the same
 * "does this table carry `updated_at`" branch every other table's
 * treatment above falls out of, not a second, hand-maintained table list.
 *
 * `kv` (device id, Sync cursors and row-shape epochs) and
 * `meologue_migrations` (this build's own migration ledger) are excluded
 * outright: neither is a "row" in the sense CONTEXT.md's Merge entry
 * means ("a Merge carries rows and nothing else"), and `settings.json` is
 * never even read here — settings belong to Restore alone.
 *
 * Every write goes through a parameterized upsert built from `parse.ts`'s
 * typed rows, never through `driver.execute` on the file's raw text —
 * identical posture to ./restore.ts, for the identical reason (that
 * file's own header comment, and ./parse.ts's).
 *
 * **`mergeBackupIntoDevice` also takes and requires a `takeSafetyBackup`
 * callback, on the identical seam issue #204 built for ./restore.ts**
 * (issue #208): `BEGIN`/`COMMIT`/`ROLLBACK` below is exactly as much of a
 * guarantee here as it is there — none at all on macOS's pooled
 * `TauriSqliteDriver` (apps/web/src/platform/tauri-sqlite-driver.ts,
 * ../sqlite/migrator.ts's own `migrate()` carries the identical caveat) —
 * so an apply interrupted partway through this file's own `mergeTable`
 * can leave the Device holding some rows the Backup overwrote and some it
 * didn't, with no record of which. This is a **smaller** harm than the
 * one issue #204 closed for Restore, not the same one: Merge never
 * deletes a row (second bullet above — "a row only this Device holds is
 * left completely alone"), so an interrupted Merge can never lose a row
 * that only ever existed locally. What it *can* still do is silently
 * apply case 6's "greater `updated_at` wins" to some rows a Backup shares
 * with this Device and not others — a state nobody chose, and, before
 * this, nothing could undo. The machinery to close that already existed
 * (#195's Backup, #204's `takeSafetyBackup` seam); this file reuses it
 * rather than deciding a half-merged Device is an acceptable state to
 * leave someone in just because it usually isn't destructive.
 */

export interface MergeResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Carried straight through from `./parse.ts`'s `ParseBackupSuccess` — see `RestoreResult`'s identical field for why. */
  skippedTables: string[];
  skippedColumns: string[];
  /** The safety Backup `takeSafetyBackup` (below) produced before this Merge wrote anything — named here too, not just in a toast, for the identical reason `RestoreResult.safetyBackupFileName` (./restore.ts) is: anything downstream of a successful Merge can still point back at "and here's the copy of what this Device held before." */
  safetyBackupFileName: string;
}

export type MergeOutcome = { ok: true; result: MergeResult } | { ok: false; reason: string };

/**
 * Deliberately the same shape as ./restore.ts's `RestoreOptions` — `driver`
 * and `databaseSql` mean the same thing in both, `takeSafetyBackup` is the
 * identical `TakeSafetyBackup` type (imported, not redeclared: a second,
 * independently-typed copy could drift), and `onProgress` is optional for
 * the identical reason it is on `RestoreOptions` (a Merge at personal-log
 * scale doesn't need one to feel responsive, but a caller that wants one
 * — the same `onProgress` closure a caller already wired up for Restore —
 * should be able to reuse it rather than write a second). A reader who
 * already knows `RestoreOptions` should recognise this on sight.
 */
export interface MergeOptions {
  driver: SqliteDriver;
  databaseSql: string;
  /** Awaited after the read-only parse and before a single mutating statement reaches `driver` — see this file's own header comment's `takeSafetyBackup` paragraph, and `TakeSafetyBackup`'s own doc comment (./restore.ts), for the full reasoning. */
  takeSafetyBackup: TakeSafetyBackup;
  onProgress?: (message: string) => void;
}

/**
 * Tables Merge never touches at all — `kv` (bookkeeping, not History: this
 * Device's own `device_id` must never change, and its Sync cursors/epochs
 * describe this Device's own relationship to a Server, not the Backup's)
 * and `meologue_migrations` (./restore.ts's own `RESTORE_EXCLUDED_TABLES`
 * doc comment gives the identical reasoning for why a migration ledger
 * from a different Device's history is never adopted).
 */
const MERGE_EXCLUDED_TABLES: ReadonlySet<string> = new Set([LEDGER_TABLE, "kv"]);

const PRIMARY_KEY_COLUMN = "id";
const UPDATED_AT_COLUMN = "updated_at";

/**
 * What Merge ignores when deciding whether a row changed, on top of the
 * `seq`/`synced_at` ./row-diff.ts already excludes for both its callers.
 * One column, and that file's own `UPDATED_AT_COLUMN` doc comment carries
 * the reasoning for why Merge passes this and Restore does not.
 */
const IGNORED_WHEN_MERGING: ReadonlySet<string> = new Set([UPDATED_AT_COLUMN]);
const DELETED_AT_COLUMN = "deleted_at";
const SEQ_COLUMN = "seq";
const SYNCED_AT_COLUMN = "synced_at";

interface MergeCounts {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Upserts one row into `tableName`, stripping `seq`/`synced_at` to `null`
 * first when the table carries them — unlike ./restore.ts, which preserves
 * both verbatim from the file (that function's own header comment, reason
 * 3), Merge always marks whatever it writes unsynced: this ticket's own
 * brief ("only rows Merge actually inserted or overwrote are marked
 * pending … so they reach the Server the way any local edit does"). A
 * Backup's `seq` was assigned by a Server against a different push from a
 * different Device; carrying it across to this Device's own row would
 * claim a Sync position this Device never earned.
 */
async function writeRow(
  driver: SqliteDriver,
  tableName: string,
  values: Record<string, unknown>,
): Promise<void> {
  const valuesToWrite: Record<string, unknown> = { ...values };
  if (SEQ_COLUMN in valuesToWrite) {
    valuesToWrite[SEQ_COLUMN] = null;
  }
  if (SYNCED_AT_COLUMN in valuesToWrite) {
    valuesToWrite[SYNCED_AT_COLUMN] = null;
  }

  const rowColumns = Object.keys(valuesToWrite);
  const placeholders = rowColumns.map(() => "?").join(", ");
  const updateAssignments = rowColumns
    .filter((column) => column !== PRIMARY_KEY_COLUMN)
    .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
    .join(", ");
  const upsertSql =
    updateAssignments.length > 0
      ? `INSERT INTO ${quoteIdent(tableName)} (${rowColumns.map(quoteIdent).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(PRIMARY_KEY_COLUMN)}) DO UPDATE SET ${updateAssignments}`
      : `INSERT INTO ${quoteIdent(tableName)} (${rowColumns.map(quoteIdent).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(PRIMARY_KEY_COLUMN)}) DO NOTHING`;
  await driver.execute(
    upsertSql,
    rowColumns.map((column) => valuesToWrite[column]),
    "run",
  );
}

/**
 * Merges one parsed table's rows into `driver`, in place — reads the whole
 * target table once up front (../backup/restore.ts's own `restoreTable`
 * doc comment gives the identical "simpler and cheaper at personal-log
 * scale than N+1 lookups" reasoning), then decides each Backup row on its
 * own:
 *
 * 1. Not on this Device at all -> insert (this file's own header comment,
 *    first bullet).
 * 2. On this Device already, byte-identical content -> skip, `unchanged`
 *    (`rowContentUnchanged`) — checked before anything below, since it
 *    must win regardless of what either side's `updated_at` says.
 * 3. A table with no `updated_at` at all (`events`, ADR 0056) -> never
 *    overwrite an existing row; only case 1 above ever touches it.
 * 4. This Device's own row is already a tombstone -> skip: delete is
 *    terminal, and an existing tombstone cannot be undone by anything the
 *    Backup carries (this file's own header comment, last bullet).
 * 5. The Backup's row is a tombstone and this Device's isn't -> always
 *    overwrite, ahead of the `updated_at` comparison below — the mirror
 *    image of case 4, and for the identical reason: a delete must reach
 *    every Device it can, terminally, even one whose local edit happens
 *    to carry a numerically greater `updated_at` than the delete it
 *    predates learning about.
 * 6. Neither side is deleted -> the greater `updated_at` wins; equal (or a
 *    Backup row somehow older) does nothing.
 *
 * A row this function decides to write always goes through `writeRow`
 * above, which is what actually marks it pending for the next Sync tick.
 */
async function mergeTable(
  driver: SqliteDriver,
  table: ParsedTable,
  counts: MergeCounts,
): Promise<void> {
  const columns = await tableColumns(driver, table.name);
  const columnNames = columns.map((column) => column.name);
  const hasUpdatedAt = columnNames.includes(UPDATED_AT_COLUMN);
  const hasDeletedAt = columnNames.includes(DELETED_AT_COLUMN);

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
    existingByPrimaryKey.set(record[PRIMARY_KEY_COLUMN], record);
  }

  for (const row of table.rows) {
    const primaryKeyValue = row.values[PRIMARY_KEY_COLUMN];
    const existing = existingByPrimaryKey.get(primaryKeyValue);

    if (existing === undefined) {
      await writeRow(driver, table.name, row.values);
      counts.inserted += 1;
      continue;
    }

    // `IGNORED_WHEN_MERGING`, not the bare two-argument call ./restore.ts
    // makes: `updated_at` is not content as far as Merge is concerned.
    // See ../backup/row-diff.ts's `UPDATED_AT_COLUMN` for why the two
    // callers differ on exactly this one column.
    if (rowContentUnchanged(existing, row.values, IGNORED_WHEN_MERGING)) {
      counts.unchanged += 1;
      continue;
    }

    if (!hasUpdatedAt) {
      // Append-only stream (events): insert-if-absent only, case 3 above.
      counts.unchanged += 1;
      continue;
    }

    const existingDeleted = hasDeletedAt && existing[DELETED_AT_COLUMN] != null;
    if (existingDeleted) {
      // Case 4: this Device's tombstone is terminal.
      counts.unchanged += 1;
      continue;
    }

    const incomingDeleted = hasDeletedAt && row.values[DELETED_AT_COLUMN] != null;
    if (incomingDeleted) {
      // Case 5: the Backup's tombstone is terminal too, ahead of the
      // updated_at comparison below.
      await writeRow(driver, table.name, row.values);
      counts.updated += 1;
      continue;
    }

    // Case 6: neither side is deleted — greater updated_at wins, equal (or
    // lesser) does nothing. Both are ISO 8601 strings of identical shape
    // (../sqlite/schema.ts's own `updatedAt` columns), so a plain string
    // comparison orders them correctly, the same assumption every other
    // `ORDER BY created_at`/`updated_at` query in this codebase already
    // makes.
    const existingUpdatedAt = existing[UPDATED_AT_COLUMN];
    const incomingUpdatedAt = row.values[UPDATED_AT_COLUMN];
    const incomingIsNewer =
      typeof incomingUpdatedAt === "string" &&
      typeof existingUpdatedAt === "string" &&
      incomingUpdatedAt > existingUpdatedAt;
    if (incomingIsNewer) {
      await writeRow(driver, table.name, row.values);
      counts.updated += 1;
    } else {
      counts.unchanged += 1;
    }
  }
}

/**
 * Applies a Backup's `database.sql` to `driver`'s own database additively
 * — see this file's own header comment for the full rule set.
 *
 * `options.takeSafetyBackup` runs first (issue #208) — after the
 * read-only parse above, before a single `BEGIN` or mutating statement
 * reaches `driver`, on the identical structural guarantee
 * `restoreFromBackup` (./restore.ts) makes for Restore: if it throws, or
 * resolves `{ ok: false }`, this function returns `{ ok: false, reason }`
 * of its own having called `driver.execute` for nothing but the read-only
 * parse — no `BEGIN`, no write, nothing to roll back. See that function's
 * own doc comment, and `SafetyBackupOutcome`'s, for the full reasoning,
 * which applies here verbatim.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK` and the post-commit FTS5 rebuild otherwise
 * mirror `restoreFromBackup` exactly, including that function's own
 * caveat about `TauriSqliteDriver` having no real transaction API: this is
 * a real guarantee on the single-connection driver this package's own
 * tests run against, and not a proven one on macOS's pooled driver today
 * — issue #208 does not narrow that gap any more than issue #204 closed
 * it for Restore, it only makes the result of hitting it recoverable. This
 * file's own header comment (the `takeSafetyBackup` paragraph) explains
 * why that gap costs Merge less than it costs Restore — an interrupted
 * Merge can leave rows unpredictably overwritten, never lose one that
 * only ever existed locally — without pretending the two carry an
 * identical risk.
 *
 * The thrown `Error` on a mid-apply failure names the safety Backup's own
 * file name, identically to `restoreFromBackup`'s own `catch` block: it
 * is, after all, an ordinary Backup, restorable the same way any other
 * one is (CONTEXT.md's Restore entry), regardless of which operation
 * triggered the app to take it.
 *
 * `settings.json` is never read here at all: CONTEXT.md's Merge entry —
 * "a Merge carries rows and nothing else" — and this ticket's own brief
 * are both explicit that settings are Restore's business, not Merge's.
 */
export async function mergeBackupIntoDevice(options: MergeOptions): Promise<MergeOutcome> {
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
      reason: `Safety Backup failed, so nothing was merged: ${safetyBackup.reason}`,
    };
  }

  const counts: MergeCounts = { inserted: 0, updated: 0, unchanged: 0 };

  await driver.execute("BEGIN", [], "run");
  try {
    for (const table of parsed.tables) {
      if (MERGE_EXCLUDED_TABLES.has(table.name)) {
        continue;
      }
      onProgress?.(`Merging ${table.name}…`);
      await mergeTable(driver, table, counts);
    }
    await driver.execute("COMMIT", [], "run");
  } catch (error) {
    await driver.execute("ROLLBACK", [], "run").catch(() => {
      // Best-effort, mirroring ./restore.ts's identical catch: if the
      // connection is already gone there is nothing left to roll back on
      // it, and the original error below is the one worth surfacing.
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Merge failed partway through: ${message} A safety Backup taken immediately before this Merge began was saved to ${safetyBackup.fileName} — restoring that file returns this Device to exactly the state it was in before this Merge started.`,
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
