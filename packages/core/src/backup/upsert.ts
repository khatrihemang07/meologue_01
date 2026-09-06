import type { SqliteDriver } from "../sqlite/driver";
import { quoteIdent } from "./dump";

/**
 * The one `INSERT ... ON CONFLICT DO UPDATE` shape ./restore.ts's
 * `restoreTable` and ./merge.ts's `writeRow` each hand-built independently
 * (issue #209) — both already agreed, without coordinating, on every part
 * of it: build placeholders from a row's own keys, exclude the primary key
 * column from the `DO UPDATE SET` list, and fall back to `DO NOTHING` when
 * there is nothing left to set once that column is excluded (a table with
 * only a primary key column, which no table in this schema is today, but
 * which the SQL itself would otherwise be invalid for). That agreement is
 * what makes this worth sharing — not a superficial resemblance, but the
 * same decision made twice.
 */

/**
 * The column both files treat as a row's identity for every table except
 * `kv` — Restore's own row-level special case, not a difference between
 * the two files (./restore.ts's `KV_PRIMARY_KEY_COLUMN`: `kv`'s rows are
 * keyed by `key`, and Merge never touches `kv` at all, so it never needs a
 * second value here). One constant, not two independently-typed copies
 * that happened to hold the same string.
 */
export const PRIMARY_KEY_COLUMN = "id";

/**
 * Builds and runs one upsert for `values` against `tableName`, keyed on
 * `primaryKeyColumn` — the shape described in this file's own header
 * comment, and nothing more. Deliberately does not decide:
 *
 * - **which column is the primary key.** Taken as a parameter, not
 *   defaulted to `PRIMARY_KEY_COLUMN` above, because Restore's `kv` case
 *   needs `key` — deciding that here would put a `kv`-shaped branch in a
 *   helper neither Merge nor any other table has a use for.
 * - **which columns `values` carries, or what they contain.** A caller
 *   that wants `seq`/`synced_at` preserved verbatim (Restore) passes a
 *   row's values unmodified; a caller that wants them blanked first to
 *   mark a row pending (Merge's `writeRow`) strips them itself before
 *   calling this — that difference is real (each file's own header
 *   comment explains why they differ on it) and stays visible at the call
 *   site rather than becoming a flag this function branches on.
 * - **whether the row should be written at all.** Every "does this row
 *   even need writing" decision — content-unchanged, a tombstone's
 *   terminal status, the `updated_at` comparison, `kv`'s `device_id` skip
 *   — happens in the caller, before this is ever reached. This function
 *   only ever runs once that question has already been answered yes.
 */
export async function upsertRow(
  driver: SqliteDriver,
  tableName: string,
  primaryKeyColumn: string,
  values: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(values);
  const placeholders = columns.map(() => "?").join(", ");
  const updateAssignments = columns
    .filter((column) => column !== primaryKeyColumn)
    .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
    .join(", ");
  const upsertSql =
    updateAssignments.length > 0
      ? `INSERT INTO ${quoteIdent(tableName)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(primaryKeyColumn)}) DO UPDATE SET ${updateAssignments}`
      : `INSERT INTO ${quoteIdent(tableName)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${quoteIdent(primaryKeyColumn)}) DO NOTHING`;
  await driver.execute(
    upsertSql,
    columns.map((column) => values[column]),
    "run",
  );
}
